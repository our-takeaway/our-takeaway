import fs from 'node:fs/promises';
import path from 'node:path';
import type { Loader } from 'astro/loaders';
import { LANGS } from '../consts';
import { tagNormalizer } from './tags';

// One Directus row holds a post in both languages. Astro gets one entry per
// language, with id "<lang>/<slug>", so each language renders as its own page.
//
// Without DIRECTUS_URL (local development) posts come from src/content/sample/<lang>/<slug>.md.

type Row = Record<string, any>;

// "publishing" is included so the post being approved right now is part of this build.
const LIVE = ['publishing', 'published'];

async function fromDirectus(url: string, token: string): Promise<Row[]> {
	const params = new URLSearchParams({
		'filter[status][_in]': LIVE.join(','),
		limit: '-1',
		sort: '-published_at',
	});
	const res = await fetch(`${url.replace(/\/$/, '')}/items/posts?${params}`, {
		headers: token ? { Authorization: `Bearer ${token}` } : {},
	});
	if (!res.ok) throw new Error(`Directus responded ${res.status}: ${await res.text()}`);
	return (await res.json()).data;
}

function parseFrontmatter(text: string) {
	// \r?: Windows checkouts can turn the sample files into CRLF
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!m) return { data: {} as Row, body: text };
	const data: Row = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^(\w+):\s*(.*)$/);
		if (!kv) continue;
		try {
			data[kv[1]] = JSON.parse(kv[2]);
		} catch {
			data[kv[1]] = kv[2];
		}
	}
	return { data, body: m[2] };
}

// Turn sample files into rows shaped like Directus rows.
async function fromSamples(dir: string): Promise<Row[]> {
	const rows = new Map<string, Row>();
	for (const lang of LANGS) {
		const files = await fs.readdir(path.join(dir, lang)).catch(() => [] as string[]);
		for (const file of files.filter((f) => f.endsWith('.md'))) {
			const slug = file.replace(/\.md$/, '');
			const { data, body } = parseFrontmatter(await fs.readFile(path.join(dir, lang, file), 'utf8'));
			const row = rows.get(slug) ?? { slug, published_at: data.pubDate, source_language: data.sourceLang ?? null };
			row[`title_${lang}`] = data.title;
			row[`description_${lang}`] = data.description;
			row[`tags_${lang}`] = data.tags ?? [];
			row[`body_${lang}`] = body;
			rows.set(slug, row);
		}
	}
	return [...rows.values()];
}

export function directusLoader(): Loader {
	return {
		name: 'directus-posts',
		async load({ store, logger, parseData, renderMarkdown }) {
			const url = process.env.DIRECTUS_URL;
			const rows = url
				? await fromDirectus(url, process.env.DIRECTUS_TOKEN ?? '')
				: await fromSamples(path.resolve('src/content/sample'));
			logger.info(`${rows.length} posts from ${url ? 'Directus' : 'sample files'}`);

			const normalizeTags = Object.fromEntries(
				LANGS.map((lang) => [lang, tagNormalizer(rows.map((row) => row[`tags_${lang}`] ?? []))]),
			);

			// Session numbers are worked out on every build from the order the posts were
			// published (oldest = 1), so they always run 1, 2, 3… with no gaps, even after a
			// post is removed or deleted. Nothing is typed in by hand.
			const hasText = (row: Row) => LANGS.some((l) => row[`body_${l}`]?.trim() && row[`title_${l}`]);
			const published = (row: Row) => new Date(row.published_at ?? row.date_created ?? Date.now()).valueOf() || 0;
			const sessionNumber = new Map(
				rows
					.filter(hasText)
					.sort((a, b) => published(a) - published(b) || (Number(a.id) || 0) - (Number(b.id) || 0))
					.map((row, i) => [row, i + 1]),
			);

			store.clear();
			for (const row of rows) {
				// the language the session was in: the post was written in it, then translated
				const sourceLang = [row.source_language, row.detected_language].find((l) => LANGS.includes(l));
				for (const lang of LANGS) {
					const body = row[`body_${lang}`];
					if (!body?.trim() || !row[`title_${lang}`]) continue;
					const id = `${lang}/${row.slug}`;
					const data = await parseData({
						id,
						data: {
							lang,
							slug: row.slug,
							title: row[`title_${lang}`],
							description: row[`description_${lang}`] ?? '',
							tags: normalizeTags[lang](row[`tags_${lang}`] ?? []),
							meeting: sessionNumber.get(row),
							sourceLang,
							pubDate: row.published_at ?? row.date_created ?? new Date().toISOString(),
							updatedDate: row.date_updated ?? undefined,
							// which other languages this post exists in, for the language switch
							langs: LANGS.filter((l) => row[`body_${l}`]?.trim() && row[`title_${l}`]),
						},
					});
					store.set({ id, data, body, rendered: await renderMarkdown(body) });
				}
			}
		},
	};
}
