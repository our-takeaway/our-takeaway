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

// ---------- diagrams (made by the worker with Napkin AI, see worker/src/diagram.js) ----------

const DIAGRAM_DIR = path.resolve('public/diagrams');
const escHtml = (s: string) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Copy the image from Directus into public/diagrams once; the site serves it from there.
async function diagramSrc(url: string, token: string, fileId: string) {
	const name = `${String(fileId).replace(/[^\w-]/g, '')}.png`;
	const target = path.join(DIAGRAM_DIR, name);
	const have = await fs.stat(target).then(() => true, () => false);
	if (!have) {
		const res = await fetch(`${url.replace(/\/$/, '')}/assets/${encodeURIComponent(fileId)}`, {
			headers: token ? { Authorization: `Bearer ${token}` } : {},
		});
		if (!res.ok) throw new Error(`diagram ${fileId}: Directus answered ${res.status}`);
		await fs.mkdir(DIAGRAM_DIR, { recursive: true });
		await fs.writeFile(target, Buffer.from(await res.arrayBuffer()));
	}
	return `/diagrams/${name}`;
}

// Put the figure in the section whose heading is `after`: right after its first paragraph
// (position "start") or at its end ("end"). No heading, or one that isn't found: after the opening.
export function placeDiagram(body: string, figure: string, after = '', position = 'end') {
	const lines = body.split('\n');
	const isH2 = (l: string) => /^##\s+/.test(l);
	const norm = (s: string) => s.replace(/^#+\s*/, '').replace(/[*_`"«»“”]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
	let at = -1;
	if (after.trim()) {
		const want = norm(after);
		let i = lines.findIndex((l) => isH2(l) && norm(l) === want);
		if (i < 0) i = lines.findIndex((l) => isH2(l) && (norm(l).includes(want) || want.includes(norm(l))));
		if (i >= 0) {
			const next = lines.findIndex((l, j) => j > i && isH2(l));
			const end = next >= 0 ? next : lines.length;
			at = end;
			if (position === 'start') {
				// the first block of text after the heading, then the blank line that ends it
				const first = lines.findIndex((l, j) => j > i && j < end && l.trim());
				if (first >= 0) {
					const blank = lines.findIndex((l, j) => j > first && j < end && !l.trim());
					at = blank >= 0 ? blank : end;
				}
			}
		}
	}
	if (at < 0) {
		const first = lines.findIndex(isH2);
		at = first >= 0 ? first : lines.length;
	}
	lines.splice(at, 0, '', figure, '');
	return lines.join('\n');
}

function diagramFigure(src: string, d: Row) {
	const size = d.width && d.height ? ` width="${Number(d.width)}" height="${Number(d.height)}"` : '';
	return [
		'<figure class="diagram">',
		`<a href="${src}" target="_blank" rel="noopener"><img src="${src}" alt="${escHtml(d.alt)}"${size} loading="lazy" decoding="async"></a>`,
		d.caption ? `<figcaption>${escHtml(d.caption)}</figcaption>` : '',
		'</figure>',
	].filter(Boolean).join('\n');
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
					let body = row[`body_${lang}`];
					if (!body?.trim() || !row[`title_${lang}`]) continue;
					const diagram = row.diagram_status === 'ready' ? row.diagram?.[lang] : null;
					if (diagram?.file && url) {
						try {
							const src = await diagramSrc(url, process.env.DIRECTUS_TOKEN ?? '', diagram.file);
							body = placeDiagram(body, diagramFigure(src, diagram), diagram.after, diagram.position);
						} catch (e) {
							logger.warn(`post ${row.slug}: diagram skipped (${(e as Error).message})`);
						}
					}
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
