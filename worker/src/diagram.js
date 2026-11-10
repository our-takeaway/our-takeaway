import { queueBuild } from './build.js';
import { showCard } from './card.js';
import { deleteFile, downloadFile, getPost, getSettings, updatePost, uploadFile } from './directus.js';
import { LANG_NAME } from './drafts.js';
import { generateVisual, napkinKeys } from './napkin.js';
import { defaultPrompt, fill } from './prompts.js';
import * as tg from './telegram.js';

// One diagram per post, drawn by Napkin AI, in each language the post has.
//
//   1. The AI reads the post and plans the diagram: the one idea a picture explains
//      best, as a few short lines (Napkin credits go by the words, so the text stays
//      under Writer Settings → diagram_words for the whole post), and the section it
//      belongs to.
//   2. Napkin draws it for each language; the PNG is saved in Directus.
//   3. The post keeps { file, width, height, after, alt, caption } per language in
//      posts.diagram; the site places it as a figure at the end of that section.

export const DIAGRAM_STYLES = [
	['Amber Harvest', 'C5PP4SBJ5NM62WKPCNSQ8BBJ68'],
	['Verdant Blend', 'CDQPRVVJCSTPRBB7E9GP8TB5DST2TWHJ'],
	['Deep Teal', 'CSQQ4VB1DGPK8BB3DXP6YWHDE8S0'],
	['Boardroom Calm', 'CSQQ4VB1DGPPTVVEDXHPGWKFDNJJTSKCC5T2TWHJ'],
	['Quiet Accent', 'CSQQ4VB1DGPPRTB7D1T2TWHJ'],
	['Pure Outline', 'CSQQ4VB1DGPP4V31CDNJTVKFBXK6JV3C5NS34'],
	['Hand-Tinted', 'D1GPWS1DCDQPRVVJCSTPRBBJ68'],
	['Soft Spectrum', 'CDQPRVVJCSTPRBBKDXK78BBJ68'],
];
// Words sent to Napkin for the whole post (both languages together); each language gets half.
// 120–300 → 60–150 words per diagram: room for precise details, credits still in check.
export const DEFAULT_DIAGRAM_WORDS = 300;
export const DEFAULT_DIAGRAM_MIN_WORDS = 120;
export const BLOG_LANGS = 2;
export const styleName = (id) => DIAGRAM_STYLES.find(([, s]) => s === id)?.[0] || id;

/** The words-per-language range from Writer Settings (totals per post ÷ 2). */
export function wordRange(s = {}) {
	const max = Math.min(400, Math.max(60, Number(s.diagram_words) || DEFAULT_DIAGRAM_WORDS));
	const min = Math.min(max, Math.max(20, Number(s.diagram_words_min) || DEFAULT_DIAGRAM_MIN_WORDS));
	return { min: Math.floor(min / BLOG_LANGS), max: Math.floor(max / BLOG_LANGS), totalMin: min, totalMax: max };
}

const LAYOUTS = ['flowchart', 'timeline', 'comparison', 'cycle', 'mindmap', 'hierarchy', 'list'];
const LANG_TAG = { fa: 'fa-IR', en: 'en-US' };
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
const langsOf = (post) => ['fa', 'en'].filter((l) => post[`body_${l}`]?.trim());

// The planning prompt is Writer Settings → Diagram prompt (default: directus/prompts/diagram.md).
// Placeholders: {{min}} {{max}} {{target}} {{languages}} {{layouts}}.
function planPrompt(template, { min, max }, langs) {
	return fill(template, {
		min,
		max,
		target: Math.round((min + max) / 2),
		languages: langs.map((l) => LANG_NAME[l]).join(' and '),
		layouts: LAYOUTS.join(', '),
	});
}

async function askAI(model, messages, schema) {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error('OPENROUTER_API_KEY is not set for the worker.');
	const res = await fetch(`${(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/chat/completions`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model,
			max_tokens: 8000,
			reasoning: { effort: 'low' },
			messages,
			response_format: { type: 'json_schema', json_schema: { name: 'diagram', strict: true, schema } },
		}),
		signal: AbortSignal.timeout(180_000),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`The AI model ${model} failed to plan the diagram (${res.status}): ${json.error?.message || JSON.stringify(json).slice(0, 300)}`);
	const text = json.choices?.[0]?.message?.content;
	try {
		return { plan: JSON.parse(text), text };
	} catch {
		throw new Error(`The AI model ${model} did not return a valid diagram plan.`);
	}
}

async function planDiagram(post, model, { min, max }, template) {
	const langs = langsOf(post);
	const str = { type: 'string' };
	const version = {
		type: 'object',
		properties: { content: str, after_heading: str, position: { type: 'string', enum: ['start', 'end'] }, alt: str, caption: str },
		required: ['content', 'after_heading', 'position', 'alt', 'caption'],
		additionalProperties: false,
	};
	const schema = {
		type: 'object',
		properties: { layout: { type: 'string', enum: LAYOUTS }, ...Object.fromEntries(langs.map((l) => [l, version])) },
		required: ['layout', ...langs],
		additionalProperties: false,
	};
	const posts = langs.map((l) => `<post lang="${l}">\n# ${post[`title_${l}`] || ''}\n\n${post[`body_${l}`]}\n</post>`).join('\n\n');
	const messages = [{ role: 'system', content: planPrompt(template, { min, max }, langs) }, { role: 'user', content: posts }];
	let { plan, text } = await askAI(model, messages, schema);

	// Too thin? Ask once for the missing detail (never padding); too long is trimmed later.
	const short = langs.filter((l) => words(plan[l]?.content) < min);
	if (short.length) {
		const counts = langs.map((l) => `${LANG_NAME[l]}: ${words(plan[l].content)} words`).join(', ');
		messages.push({ role: 'assistant', content: text }, {
			role: 'user',
			content: `The diagram text is too short (${counts}). Rewrite it with between ${min} and ${max} words per language: ` +
				'make each item\'s detail more precise with what the post actually says (what, how, why, numbers, names), or add an item the idea needs. ' +
				'No filler. Keep the same idea, layout and placement.',
		});
		({ plan } = await askAI(model, messages, schema));
	}
	return { langs, plan };
}

// Keep the text within the word budget: drop items from the end, but never the title
// or a closing "Decision:" / "Result:" line.
export function fit(content, limit) {
	const lines = String(content).split('\n').map((l) => l.trim()).filter(Boolean);
	const outcome = /^(decision|result|تصمیم|نتیجه)\s*[:：]/i.test(lines.at(-1) || '') ? lines.pop() : null;
	const total = () => words([...lines, outcome].filter(Boolean).join(' '));
	while (lines.length > 2 && total() > limit) lines.pop();
	if (outcome) lines.push(outcome);
	const text = lines.join('\n');
	return words(text) > limit ? text.split(/\s+/).slice(0, limit).join(' ') : text;
}

const making = new Set();

/** Plan, draw and save the post's diagram. Updates the card as it goes; never throws. */
export async function makeDiagram(id, who = 'someone') {
	if (making.has(id)) return;
	making.add(id);
	const old = (await getPost(id).catch(() => null))?.diagram;
	try {
		if (!napkinKeys().length) throw new Error('No Napkin API key. Add NAPKIN_API_KEY_1 (and optionally _2, _3) to .env.');
		await updatePost(id, { diagram_status: 'making' });
		await showCard(id, { note: `📊 Making a diagram… (${who})` });

		const [post, s] = await Promise.all([getPost(id), getSettings()]);
		const range = wordRange(s);
		const style = s.diagram_style || DIAGRAM_STYLES[0][1];
		const template = s.diagram_prompt?.trim() || defaultPrompt('diagram_prompt');
		const { langs, plan } = await planDiagram(post, post.llm_model || s.model, range, template);
		const limit = range.max;

		const result = { layout: plan.layout, style, at: new Date().toISOString() };
		for (const lang of langs) {
			const v = plan[lang];
			const content = fit(v.content, limit);
			const drawn = await generateVisual({
				format: 'png',
				content,
				language: LANG_TAG[lang],
				style_id: style,
				visual_query: plan.layout,
				number_of_visuals: 1,
				width: 1600,
				text_extraction_mode: 'preserve',
				color_mode: 'light',
				transparent_background: false,
			});
			const file = await uploadFile(`post-${id}-diagram.${lang}.png`, drawn.buffer, 'image/png', `Diagram #${id} (${LANG_NAME[lang]})`);
			result[lang] = {
				file, width: drawn.width, height: drawn.height,
				after: v.after_heading.trim(), position: v.position === 'end' ? 'end' : 'start',
				alt: v.alt.trim(), caption: v.caption.trim(), text: content, words: words(content), key: drawn.key,
			};
		}

		await updatePost(id, { diagram: result, diagram_status: 'ready' });
		for (const lang of ['fa', 'en']) if (old?.[lang]?.file) await deleteFile(old[lang].file).catch(() => {});
		const used = langs.map((l) => `${LANG_NAME[l]} ${result[l].words}`).join(' + ');
		if (post.status === 'published') queueBuild().catch((e) => console.error('build after diagram:', e.message));
		await showCard(id, { repost: true, note: `📊 Diagram ready (${used} words). 🖼 See it below the buttons.` });
	} catch (e) {
		console.error(`diagram #${id}:`, e.message);
		// a diagram that was already there stays; the error is shown next to it
		const kept = Boolean(old?.fa?.file || old?.en?.file);
		await updatePost(id, { diagram_status: kept ? 'ready' : 'failed', diagram: { ...(old || {}), error: e.message.slice(0, 1500) } }).catch(() => {});
		await showCard(id, { repost: true, note: `📊 The diagram failed (${who} asked).` }).catch(() => {});
	} finally {
		making.delete(id);
	}
}

/** Take the diagram off the post (and the site, if it is live). */
export async function removeDiagram(id, who) {
	const post = await getPost(id);
	await updatePost(id, { diagram_status: 'no', diagram: null });
	for (const lang of ['fa', 'en']) if (post.diagram?.[lang]?.file) await deleteFile(post.diagram[lang].file).catch(() => {});
	if (post.status === 'published') queueBuild().catch((e) => console.error('build after diagram removal:', e.message));
	return showCard(id, { note: `🗑 Diagram removed (${who})` });
}

/** Send the diagram images to a chat, to look at before publishing. */
export async function sendDiagram(id, chatId) {
	const post = await getPost(id);
	for (const lang of ['fa', 'en']) {
		const d = post.diagram?.[lang];
		if (!d?.file) continue;
		const where = d.after ? `Placed at the ${d.position === 'end' ? 'end' : 'start'} of “${d.after}”` : 'Placed after the opening';
		const caption = `📊 <b>#${id}</b> ${LANG_NAME[lang]} · ${tg.esc(d.caption || '')}\n<i>${tg.esc(where)} · ${d.words} words</i>`;
		await tg.sendPhoto(await downloadFile(d.file), `post-${id}-diagram.${lang}.png`, { chatId, caption });
	}
}

export const diagramError = (post) => post.diagram?.error || '';
