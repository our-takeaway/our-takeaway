import fs from 'node:fs';
import path from 'node:path';
import { cmsLink, getPost, postUrl } from './directus.js';
import { LANG_NAME } from './drafts.js';
import * as tg from './telegram.js';

// One live "card" per post in each Telegram chat. It is edited in place as the
// post moves through the pipeline (progress bar + steps), and it carries the
// buttons that make sense right now. At the moments that need you (ready for
// review, an error, published, removed) the card moves to the bottom of the chat,
// so Telegram notifies you, instead of sending another message.
//
// Which message is the card, and what each step reported, is kept in a small JSON
// file (BOT_STATE_FILE), not in Directus, so it never touches a post's content.

// ---------- state ----------

const FILE = path.resolve(process.env.BOT_STATE_FILE || './data/telegram-cards.json');
let cache = null;

function all() {
	if (!cache) {
		try {
			cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
		} catch {
			cache = {};
		}
	}
	return cache;
}
function save() {
	try {
		fs.mkdirSync(path.dirname(FILE), { recursive: true });
		fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(all()));
		fs.renameSync(`${FILE}.tmp`, FILE);
	} catch (e) {
		console.error('card state:', e.message);
	}
}
const stateOf = (id) => (all()[id] ??= { cards: {}, steps: {} });

// The names used last time, offered as one-tap answers to "who is speaking?"
export const lastSpeakers = () => all()._speakers || [];
export function rememberSpeakers(names) {
	if (names?.length) {
		all()._speakers = names;
		save();
	}
}

// Each voice in the transcript with a few of its first words, so you can tell who is who.
export function voicesOf(transcript) {
	const voices = new Map();
	for (const m of String(transcript || '').matchAll(/^\[[^\]]*\]\s*Speaker (\d+):\s*(.*)$/gm)) {
		const v = voices.get(m[1]) ?? voices.set(m[1], []).get(m[1]);
		if (m[2].trim().split(/\s+/).length >= 5 && v.join(' ').length < 120) v.push(m[2].trim());
	}
	return [...voices].map(([n, lines]) => {
		const text = lines.join(' … ');
		return { n: Number(n), sample: text.length > 140 ? `${text.slice(0, 137)}…` : text };
	});
}

// one update per post at a time, so two quick reports never create two cards
const locks = new Map();
function locked(id, fn) {
	const run = (locks.get(id) || Promise.resolve()).catch(() => {}).then(fn);
	locks.set(id, run);
	run.finally(() => locks.get(id) === run && locks.delete(id)).catch(() => {});
	return run;
}

// ---------- steps ----------

const ORDER = ['transcribe', 'write', 'translate', 'review', 'publish'];
const NAME = {
	transcribe: ['Transcription', 'Transcribing…', 'Transcription failed'],
	write: ['Writing', 'Writing…', 'Writing failed'],
	translate: ['Translation', 'Translating…', 'Translation failed'],
	publish: ['Published', 'Publishing…', 'Publishing failed'],
};
const MARK = { done: '✅', run: '⏳', error: '❌', wait: '👀', removed: '🙈', pending: '▫️' };
const CELL = { done: '🟩', run: '🟨', error: '🟥', wait: '🟦', removed: '⬛', pending: '⬜' };
const AFTER_REVIEW = ['approved', 'publishing', 'published', 'archived'];

// A pipeline report changes the steps: a step that (re)starts clears the steps after it.
function applyStage(st, stage, state, info = {}) {
	const steps = st.steps;
	if (stage === 'speakers') return; // a pause between two steps; the post's status shows it
	if (stage === 'remove') {
		steps.publish = { s: { start: 'removing', done: 'removed', error: 'error' }[state], info };
		return;
	}
	if (state === 'start') for (const later of ORDER.slice(ORDER.indexOf(stage))) delete steps[later];
	steps[stage] = { s: { start: 'run', done: 'done', error: 'error' }[state], info, at: Date.now() };
}

const fmtSeconds = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const shortModel = (m) => String(m || '').replace(/^[^/:]+[/:]/, '');

function details(info = {}) {
	const bits = [];
	if (info.from && info.to) bits.push(`${LANG_NAME[info.from]} → ${LANG_NAME[info.to]}`);
	else if (info.lang || info.language) bits.push(LANG_NAME[info.lang || info.language] || info.lang || info.language);
	if (info.model) bits.push(shortModel(info.model));
	if (info.seconds) bits.push(fmtSeconds(info.seconds));
	return bits.join(' · ');
}

// What each step shows right now, from the reports plus the post's status
// (posts from before the cards, or changed in the CMS, still look right).
function stepsOf(post, st) {
	const s = st.steps || {};
	const status = post.status;
	const later = (k) =>
		ORDER.slice(ORDER.indexOf(k) + 1).some((x) => s[x]) || status === 'review' || AFTER_REVIEW.includes(status) || (k === 'transcribe' && status === 'speakers');
	const out = {};
	for (const k of ['transcribe', 'write', 'translate']) {
		out[k] = s[k] ? { ...s[k] } : later(k) ? { s: 'done' } : { s: 'pending' };
	}
	if (status === 'speakers') out.write = { s: 'wait' };
	if (status === 'error' && post.error_stage && out[post.error_stage]) out[post.error_stage] = { ...out[post.error_stage], s: 'error' };

	out.review = status === 'review' ? { s: 'wait' } : AFTER_REVIEW.includes(status) || s.publish ? { s: 'done' } : { s: 'pending' };

	const p = s.publish?.s;
	if (status === 'archived') {
		// until the removal reports back, the post is still on the site
		const removing = ['removing', 'run', 'done'].includes(p);
		out.publish = { s: removing ? 'run' : 'removed', removing };
	}
	else if (status === 'published') out.publish = { s: 'done', info: s.publish?.info };
	else if (status === 'approved' || status === 'publishing') out.publish = { s: 'run' };
	else if (status === 'error' && post.error_stage === 'publish') out.publish = { s: 'error' };
	else out.publish = { s: 'pending' };
	return out;
}

function stepLine(key, step) {
	if (key === 'review') {
		const label = { wait: 'Review · waiting for you', done: 'Reviewed', pending: 'Review' }[step.s] || 'Review';
		return `${MARK[step.s]} ${label}`;
	}
	if (key === 'write' && step.s === 'wait') return `${MARK.wait} Writing · waiting for the speakers' names`;
	if (key === 'publish' && step.s === 'removed') return `${MARK.removed} Removed from the site`;
	if (key === 'publish' && step.removing) return `${MARK.run} Removing from the site…`;
	const [done, run, error] = NAME[key];
	const label = key === 'publish' && step.s === 'pending' ? 'Publish' : { done, run, error, pending: done }[step.s];
	const extra = step.s === 'done' || step.s === 'run' ? details(step.info) : '';
	return `${MARK[step.s]} ${label}${extra ? ` · ${tg.esc(extra)}` : ''}`;
}

// ---------- card text ----------

const titleOf = (p) => p.title_fa || p.title_en || p.title || `Post ${p.id}`;
const otherTitle = (p) => (p.title_fa && p.title_en ? p.title_en : null);

export function speakersOf(notes) {
	return [...String(notes || '').matchAll(/speaker\s*(\d+)\s*[=:]\s*([^\n,،;]+)/gi)].map((m) => m[2].trim()).filter(Boolean);
}

function shortError(post) {
	const msg = String(post.error_message || '').match(/^Message: (.*)$/m)?.[1] || String(post.error_message || '').split('\n')[0];
	return msg.length > 280 ? `${msg.slice(0, 277)}…` : msg;
}

function headline(post, url, st) {
	switch (post.status) {
		case 'new': return '🆕 New post. The transcription starts in a moment.';
		case 'transcribing':
		case 'writing':
		case 'translating': return '⏳ Working on it. This message updates itself.';
		case 'speakers': {
			const voices = voicesOf(post.transcript);
			return [
				`🗣 <b>Who is speaking?</b> The recording has ${voices.length} voices. Name them so the post can say who said what, or write it as “we”.`,
				'',
				...voices.map((v) => `<b>Speaker ${v.n}:</b> <i>${tg.esc(v.sample || '…')}</i>`),
			].join('\n');
		}
		case 'revise': return '✏️ Rewriting with your feedback…';
		case 'retry': return '🔁 Starting again…';
		case 'review': return '👀 <b>Ready for review.</b> Read 📄 Drafts, then ✅ Publish or ✏️ Ask for changes.';
		case 'approved':
		case 'publishing': return '🚀 Publishing…';
		case 'published': return url ? `🌍 <b>Live:</b> ${tg.esc(url)}` : '🌍 <b>Live on the site.</b>';
		case 'archived': return ['removing', 'run', 'done'].includes(st.steps?.publish?.s)
			? '🙈 Taking it off the site…'
			: '🙈 <b>Not on the site.</b> Tap 🚀 Publish again to bring it back.';
		case 'error': return `❌ <b>${tg.esc(NAME[post.error_stage]?.[2] || 'A step failed')}:</b> ${tg.esc(shortError(post))}\nFix it (for example 🤖 pick another model), then 🔁 Retry.`;
		default: return '';
	}
}

const clock = (t) => new Date(t).toLocaleString('en-GB', { timeZone: process.env.TZ || 'Asia/Tehran', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export function renderText(post, st, extra) {
	const steps = stepsOf(post, st);
	const cells = ORDER.map((k) => CELL[steps[k].s]).join('');
	const done = ORDER.filter((k) => ['done', 'removed'].includes(steps[k].s)).length;
	const url = postUrl(post);
	const lang = post.source_language || post.detected_language;
	const speakers = speakersOf(post.notes);
	const meta = [
		`🌐 ${lang ? LANG_NAME[lang] : 'language: auto'}`,
		post.llm_model ? `🤖 ${shortModel(post.llm_model)}` : null,
		`🗣 ${speakers.length ? speakers.join(', ') : 'speakers not set'}`,
	].filter(Boolean).join(' · ');

	const lines = [
		`<b>#${post.id}</b> · <b>${tg.esc(titleOf(post))}</b>`,
		otherTitle(post) ? `<i>${tg.esc(otherTitle(post))}</i>` : null,
		'',
		`${cells}  ${Math.round((done / ORDER.length) * 100)}%`,
		...ORDER.map((k) => stepLine(k, steps[k])),
		'',
		headline(post, url, st),
		steps.publish.s === 'done' && steps.publish.info?.note ? `<i>${tg.esc(steps.publish.info.note)}</i>` : null,
		'',
		`<i>${tg.esc(meta)}</i>`,
		st.note ? `<i>${tg.esc(st.note.text)} · ${clock(st.note.at)}</i>` : null,
		extra ? `\n${extra}` : null,
	];
	return lines.filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------- buttons ----------

const b = (text, data) => ({ text, data });
const link = (text, url) => ({ text, url });

function mainButtons(post) {
	const id = post.id;
	const url = postUrl(post);
	const rows = [];
	switch (post.status) {
		case 'speakers': {
			// one tap for the usual pair, in either order
			const voices = voicesOf(post.transcript).length;
			const names = lastSpeakers();
			if (names.length === voices) {
				const label = (list) => `🗣 ${list.map((n, i) => `${i + 1} = ${n}`).join(' · ')}`.slice(0, 60);
				rows.push([b(label(names), `spn:${id}:0`)]);
				if (voices === 2) rows.push([b(label([...names].reverse()), `spn:${id}:1`)]);
			}
			rows.push([b('✍️ Type the names', `spt:${id}`), b('👥 Write it as “we”', `spw:${id}`)]);
			break;
		}
		case 'review':
			rows.push([b('✅ Publish', `pub:${id}`), b('✏️ Ask for changes', `rev:${id}`)]);
			rows.push([b('📄 Drafts', `drafts:${id}`), b('🔁 Rewrite', `rw:${id}`), b('🌐 Re-translate', `rt:${id}`)]);
			break;
		case 'published':
			rows.push([...(url ? [link('🌍 View', url)] : []), b('🙈 Unpublish', `unpub:${id}`)]);
			rows.push([b('📄 Drafts', `drafts:${id}`), b('✏️ Ask for changes', `rev:${id}`)]);
			break;
		case 'archived':
			rows.push([b('🚀 Publish again', `pub:${id}`), b('✏️ Ask for changes', `rev:${id}`)]);
			rows.push([b('📄 Drafts', `drafts:${id}`), b('🔁 Rewrite', `rw:${id}`)]);
			break;
		case 'error':
			rows.push([b('🔁 Retry', `retry:${id}`), b('🔄 Start over', `restart:${id}`)]);
			rows.push([b('🤖 Change model', `mdl:${id}`), b('📋 Full error', `err:${id}`)]);
			break;
		default:
			rows.push([b('🔄 Refresh', `ref:${id}`)]);
	}
	rows.push([
		b('⚙️ Settings', `set:${id}`),
		...(post.transcript ? [b('📜 Transcript', `tr:${id}`)] : []),
		link('🔗 CMS', cmsLink(id)),
	]);
	return rows;
}

const back = (id) => [b('⬅️ Back', `back:${id}`)];

function settingsButtons(post) {
	const id = post.id;
	const lang = post.source_language ? LANG_NAME[post.source_language] : 'auto';
	return [
		[b('🗣 Speakers & notes', `spk:${id}`), b(`🌐 Language: ${lang}`, `lang:${id}`)],
		[b('🤖 AI / speech model', `mdl:${id}`)],
		[b('🗑 Delete post', `del:${id}`)],
		back(id),
	];
}

function languageButtons(post) {
	const id = post.id;
	const mark = (v) => ((post.source_language || 'auto') === v ? '✓ ' : '');
	return [[b(`${mark('fa')}فارسی`, `lang:${id}:fa`), b(`${mark('en')}English`, `lang:${id}:en`), b(`${mark('auto')}Auto`, `lang:${id}:auto`)], back(id)];
}

function modelButtons(post, settings, llm, stt) {
	const id = post.id;
	const curLlm = post.llm_model || settings.model;
	const curStt = post.stt_model || settings.stt_model;
	const mark = (v, cur) => (v === cur ? '✓ ' : '');
	return [
		...llm.slice(0, 8).map((m, i) => [b(`${mark(m, curLlm)}AI: ${m}`, `llm:${id}:${i}`)]),
		...stt.slice(0, 5).map((m, i) => [b(`${mark(m, curStt)}Speech: ${m}`, `stt:${id}:${i}`)]),
		back(id),
	];
}

const CONFIRM = {
	unpub: ['🙈 Take this post off the site?', '🙈 Yes, unpublish'],
	del: ['🗑 Delete this post for good? It is removed from the CMS and the site, and can\'t be undone.', '🗑 Yes, delete'],
	rw: ['🔁 Rewrite the draft? The post leaves the site until you publish it again.', '🔁 Yes, rewrite'],
	rt: ['🌐 Translate again? The post leaves the site until you publish it again.', '🌐 Yes, translate'],
	restart: ['🔄 Start over from the transcription? The post leaves the site until you publish it again.', '🔄 Yes, start over'],
};

// view: 'main' | 'settings' | 'language' | { models: [llm, stt, settings] } | { confirm: action }
function render(post, st, view = 'main') {
	if (view === 'settings') return { text: renderText(post, st, '⚙️ <b>Settings for this post</b>'), buttons: settingsButtons(post) };
	if (view === 'language') return { text: renderText(post, st, '🌐 <b>Language of the session</b> (the post is written in it, then translated)'), buttons: languageButtons(post) };
	if (view?.models) {
		const [llm, stt, settings] = view.models;
		return { text: renderText(post, st, '🤖 <b>Pick the AI model</b> (writing and translation) <b>or the speech-to-text model</b> for this post'), buttons: modelButtons(post, settings, llm, stt) };
	}
	if (view?.confirm) {
		const [question, yes] = CONFIRM[view.confirm];
		return { text: renderText(post, st, `<b>${tg.esc(question)}</b>`), buttons: [[b(yes, `${view.confirm}:${post.id}:ok`), b('⬅️ Cancel', `back:${post.id}`)]] };
	}
	return { text: renderText(post, st), buttons: mainButtons(post) };
}

// ---------- showing the card ----------

// Edit the card in each chat, or (repost) move it to the bottom so Telegram notifies.
async function deliver(post, st, { repost = false, view, chatId, messageId } = {}) {
	const { text, buttons } = render(post, st, view);
	for (const chat of chatId ? [String(chatId)] : tg.chats()) {
		const current = chat === String(chatId) && messageId ? messageId : st.cards[chat];
		if (current && !repost && (await tg.editText(chat, current, text, buttons))) {
			st.cards[chat] = current;
			continue;
		}
		if (current && !(await tg.deleteMessage(chat, current))) {
			await tg.editText(chat, current, `⬇️ <b>#${post.id}</b> · ${tg.esc(titleOf(post))} moved down.`, []);
		}
		const [sent] = await tg.sendText(text, { chatId: chat, buttons });
		if (sent) st.cards[chat] = sent.message_id;
	}
	save();
}

/** Re-draw a post's card. note: a short line about the last action ("Publishing… (Sajad)"). */
export function showCard(id, { note, ...opts } = {}) {
	if (!tg.enabled()) return Promise.resolve();
	return locked(id, async () => {
		const st = stateOf(id);
		if (note !== undefined) st.note = note ? { text: note, at: Date.now() } : null;
		const post = await getPost(id);
		await deliver(post, st, opts);
	});
}

/** A pipeline step report (from n8n through POST /stage). */
export function onStage(post, stage, state, info) {
	if (!tg.enabled()) return Promise.resolve();
	return locked(post.id, async () => {
		const st = stateOf(post.id);
		applyStage(st, stage, state, info);
		const milestone = state === 'error' || stage === 'speakers' || (state === 'done' && ['translate', 'publish', 'remove'].includes(stage));
		if (milestone) st.note = null;
		await deliver(post, st, { repost: milestone || Object.keys(st.cards).length === 0 });
	});
}

/** The post was deleted: the card says so and loses its buttons. */
export function onDeleted(id, who) {
	return locked(id, async () => {
		const st = stateOf(id);
		for (const [chat, msg] of Object.entries(st.cards)) await tg.editText(chat, msg, `🗑 <b>#${id}</b> was deleted${who ? ` by ${tg.esc(who)}` : ''}.`, []);
		delete all()[id];
		save();
	});
}

export const cardMessageOf = (id, chatId) => all()[id]?.cards?.[String(chatId)];
