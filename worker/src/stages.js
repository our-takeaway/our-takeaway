import { onStage } from './card.js';
import { getPost, getSettings, updatePost } from './directus.js';
import { LANG_NAME } from './drafts.js';

// n8n reports every step here: POST /stage { postId, stage, state, info?, error? }
//   stage: transcribe | speakers | write | translate | publish | remove
//   state: start | done | error
// We update the post (status, current step, progress log, full error) and the post's Telegram card.
//
// "speakers" start means: the transcript has several voices and nobody has named them yet.
// The run stops; the post waits in status "speakers" until someone names them (or chooses
// "we") and sets it to Retry, which continues with writing.

export const STAGES = {
	transcribe: { name: 'Transcription', icon: '🎙', status: 'transcribing' },
	speakers: { name: 'Waiting for speaker names', icon: '🗣', status: 'speakers' },
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
	if (stage === 'speakers') return `${s.icon} ${s.name}${info.voices ? ` · ${info.voices} voices` : ''}`;
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
		// waiting for names: a plain Retry (CMS or bot) then continues with writing
		Object.assign(patch, { current_stage: stage === 'speakers' ? 'write' : stage, error_stage: null, error_message: null });
		if (STAGES[stage].status) patch.status = STAGES[stage].status;
	} else if (state === 'done') {
		if (stage === 'translate') patch.status = 'review';
		if (stage === 'publish') patch.status = 'published';
	} else {
		errorText = fullError(stage, error);
		Object.assign(patch, { status: 'error', error_stage: stage, error_message: errorText });
	}

	const post = await updatePost(postId, patch);
	await onStage(post, stage, state, info).catch((e) => console.error('telegram:', e.message));
	return { ok: true, status: post.status };
}
