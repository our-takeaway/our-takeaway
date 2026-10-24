import { cmsLink, getPost, getSettings, updatePost } from './directus.js';
import { draftFile, draftFilename, LANG_NAME } from './drafts.js';
import * as tg from './telegram.js';

// n8n reports every step here: POST /stage { postId, stage, state, info?, error? }
//   stage: transcribe | write | translate | publish | remove
//   state: start | done | error
// We update the post (status, current step, progress log, full error) and tell Telegram.

export const STAGES = {
	transcribe: { name: 'Transcription', icon: '🎙', status: 'transcribing' },
	write: { name: 'Writing', icon: '✍️', status: 'writing' },
	translate: { name: 'Translation', icon: '🌐', status: 'translating' },
	publish: { name: 'Publishing', icon: '🚀', status: 'publishing' },
	remove: { name: 'Removing from site', icon: '🗑', status: null },
};

const MAX_LOG_LINES = 300;

function now() {
	return new Date().toLocaleString('en-GB', {
		timeZone: process.env.TZ || 'Asia/Tehran', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
	});
}

const fmtSeconds = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const titleOf = (p) => p.title_fa || p.title_en || p.title || `Post ${p.id}`;
const other = (lang) => (lang === 'fa' ? 'en' : 'fa');

// One line for the post's progress log, and the matching Telegram text.
function describe(stage, state, info = {}) {
	const s = STAGES[stage];
	const bits = [];
	if (info.model) bits.push(info.model);
	if (info.language) bits.push(`language: ${info.language}`);
	if (info.chars) bits.push(`${info.chars.toLocaleString('en')} chars`);
	if (info.seconds !== undefined) bits.push(fmtSeconds(info.seconds));
	if (info.from && info.to) bits.push(`${LANG_NAME[info.from]} → ${LANG_NAME[info.to]}`);
	if (info.lang && !info.from) bits.push(LANG_NAME[info.lang]);
	if (info.note) bits.push(info.note);
	const verb = { start: 'started', done: 'done', error: 'FAILED' }[state];
	return `${s.icon} ${s.name} ${verb}${bits.length ? ' · ' + bits.join(' · ') : ''}`;
}

export function fullError(stage, error = {}) {
	const lines = [
		`Step: ${STAGES[stage]?.name || stage}`,
		error.node ? `Node: ${error.node}` : null,
		`Message: ${String(error.message || 'Unknown error').replace(/ \[line \d+\]$/, '')}`,
		error.description && error.description !== error.message ? `Details: ${error.description}` : null,
		error.httpCode ? `HTTP status: ${error.httpCode}` : null,
		error.executionUrl ? `n8n execution: ${error.executionUrl}` : null,
		`Time: ${now()}`,
	];
	return lines.filter(Boolean).join('\n');
}

const reviewButtons = (id) => [
	[{ text: '✅ Publish', data: `approve:${id}` }, { text: '✏️ Revise', data: `revise:${id}` }],
	[{ text: '🔁 Rewrite', data: `rewrite:${id}` }, { text: '🌐 Re-translate', data: `retranslate:${id}` }],
	[{ text: '🤖 Change model', data: `models:${id}` }, { text: '🔗 Open in CMS', url: cmsLink(id) }],
];

const errorButtons = (id) => [
	[{ text: '🔁 Retry this step', data: `retry:${id}` }, { text: '🔄 Start over', data: `restart:${id}` }],
	[{ text: '🤖 Change model', data: `models:${id}` }, { text: '🔗 Open in CMS', url: cmsLink(id) }],
];

async function tell(post, stage, state, info, line, errorText) {
	if (!tg.enabled()) return;
	const head = `<b>#${post.id}</b> ${tg.esc(titleOf(post))}\n${tg.esc(line)}`;
	const id = post.id;

	if (state === 'error') {
		return tg.sendLong(head, `<pre>${tg.esc(errorText)}</pre>`, `post-${id}-error.txt`, { buttons: errorButtons(id) });
	}
	if (stage === 'transcribe' && state === 'done' && post.transcript) {
		return tg.sendDocument(`post-${id}-transcript.txt`, post.transcript, { caption: head });
	}
	if (stage === 'translate' && state === 'done') {
		const src = info.from || 'fa';
		await tg.sendDocument(draftFilename(id, src), draftFile(post, src), { caption: `#${id} ${LANG_NAME[src]} draft` });
		await tg.sendDocument(draftFilename(id, other(src)), draftFile(post, other(src)), { caption: `#${id} ${LANG_NAME[other(src)]} draft` });
		return tg.sendText(
			`📝 <b>#${id}</b> ${tg.esc(titleOf(post))} is ready for review.\n\n` +
				`To edit: reply to a draft file with your edited copy (keep the file name), ` +
				`or tap ✏️ Revise and say what should change.`,
			{ buttons: reviewButtons(id) },
		);
	}
	if (stage === 'publish' && state === 'done') {
		const buttons = [[...(info.url ? [{ text: '🌍 View post', url: info.url }] : []), { text: '🔗 Open in CMS', url: cmsLink(id) }]];
		const social = [info.x, info.reddit].filter(Boolean).map((s) => tg.esc(s)).join('\n');
		return tg.sendText(`${head}${info.url ? `\n${tg.esc(info.url)}` : ''}${social ? `\n\n${social}` : ''}`, { buttons });
	}
	return tg.sendText(head);
}

export async function reportStage({ postId, stage, state, info = {}, error }) {
	if (!STAGES[stage]) throw Object.assign(new Error(`unknown stage "${stage}"`), { status: 400 });
	if (!['start', 'done', 'error'].includes(state)) throw Object.assign(new Error(`unknown state "${state}"`), { status: 400 });

	const before = await getPost(postId);
	if (stage === 'transcribe' && state === 'start' && !info.model) {
		info = { ...info, model: before.transcript_file ? 'transcript file' : before.stt_model || (await getSettings()).stt_model };
	}
	const line = describe(stage, state, info);
	const log = [...String(before.pipeline_log || '').split('\n').filter(Boolean), `- ${now()} · ${line}`].slice(-MAX_LOG_LINES).join('\n');
	const patch = { pipeline_log: log };
	let errorText;

	if (state === 'start') {
		Object.assign(patch, { current_stage: stage, error_stage: null, error_message: null });
		if (STAGES[stage].status) patch.status = STAGES[stage].status;
	} else if (state === 'done') {
		if (stage === 'translate') patch.status = 'review';
		if (stage === 'publish') patch.status = 'published';
	} else {
		errorText = fullError(stage, error);
		Object.assign(patch, { status: 'error', error_stage: stage, error_message: errorText });
	}

	const post = await updatePost(postId, patch);
	await tell(post, stage, state, info, line, errorText).catch((e) => console.error('telegram:', e.message));
	return { ok: true, status: post.status };
}
