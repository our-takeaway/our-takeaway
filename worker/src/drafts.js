// A post's draft in one language as an editable Markdown file:
//
//   ---
//   title: …
//   description: …
//   tags: a, b, c
//   ---
//
//   body…
//
// Sent to Telegram for review; sending an edited copy back updates the post.

export const LANG_NAME = { fa: 'Persian', en: 'English' };

export const draftFilename = (id, lang) => `post-${id}.${lang}.md`;

export function draftFile(post, lang) {
	const tags = (post[`tags_${lang}`] || []).join(', ');
	return [
		'---',
		`title: ${(post[`title_${lang}`] || '').replace(/\n/g, ' ')}`,
		`description: ${(post[`description_${lang}`] || '').replace(/\n/g, ' ')}`,
		`tags: ${tags}`,
		'---',
		'',
		(post[`body_${lang}`] || '').trim(),
		'',
	].join('\n');
}

export function parseDraftFile(text, lang) {
	const m = String(text).replace(/^﻿/, '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
	if (!m) return { [`body_${lang}`]: String(text).trim() + '\n' };
	const fields = {};
	for (const line of m[1].split('\n')) {
		const kv = line.match(/^(title|description|tags)\s*:\s*(.*)$/i);
		if (kv) fields[kv[1].toLowerCase()] = kv[2].trim();
	}
	const out = { [`body_${lang}`]: m[2].trim() + '\n' };
	if (fields.title) out[`title_${lang}`] = fields.title;
	if (fields.description !== undefined) out[`description_${lang}`] = fields.description;
	if (fields.tags !== undefined) out[`tags_${lang}`] = fields.tags.split(/[,،]/).map((t) => t.trim()).filter(Boolean);
	return out;
}

// Which post/language a filename refers to, e.g. post-12.fa.md → { id: 12, lang: 'fa' }
export function parseDraftFilename(name = '') {
	const m = name.match(/post-(\d+)\.(fa|en)\.md$/i);
	return m ? { id: Number(m[1]), lang: m[2].toLowerCase() } : null;
}
