import path from 'node:path';
import { createPost, getPost, getSettings, updatePost, uploadFile } from './directus.js';
import { LANG_NAME, parseDraftFile, parseDraftFilename } from './drafts.js';
import * as tg from './telegram.js';
import { isTranscriptFile } from './textfile.js';

// Telegram → CMS. Every action just changes the post in Directus; Directus then
// tells n8n, exactly as if you had done it in the CMS.
//
//   buttons          approve · revise · rewrite · retranslate · retry · restart · models · llm · stt
//   reply with text  → feedback, then the AI revises the draft
//   reply with a     post-<id>.<lang>.md file → that language's draft is replaced
//   send a recording, transcript file or link (not as a reply) → new post

const TG_MAX_DOWNLOAD = 20 * 1024 * 1024; // Telegram bots can't download bigger files

export const DEFAULT_LLM_CHOICES = [
	'deepseek/deepseek-v4-flash-0731',
	'deepseek/deepseek-v4.1-flash',
	'deepseek/deepseek-v4-pro',
	'google/gemini-3.8-flash',
	'anthropic/claude-sonnet-5.5',
];
export const DEFAULT_STT_CHOICES = ['elevenlabs:scribe_v2', 'whisper:whisper-large-v3', 'whisper:whisper-large-v3-turbo'];

const postIdIn = (text) => Number(String(text || '').match(/#(\d+)\b/)?.[1]) || null;
const allowed = (chatId) => tg.chats().includes(String(chatId));
const say = (chatId, text, opts = {}) => tg.sendText(text, { ...opts, chatId });

const HELP =
	'<b>Our Takeaway bot</b>\n\n' +
	'• Send a <b>recording</b> (voice, audio or video up to 20 MB), a <b>transcript file</b> (txt, md, srt, vtt, docx, pdf) ' +
	'or a <b>Google Drive link</b> to start a new post. Add a caption to set its title.\n' +
	'• You get a message for every step, and the drafts as <code>.md</code> files.\n' +
	'• To edit a draft: change the file and send it back as a reply (keep the file name).\n' +
	'• To ask for changes: reply to any message of a post with what should change.\n' +
	'• Use the buttons to publish, retry a failed step, or switch the AI or speech-to-text model.\n\n' +
	'Bigger recordings: upload them in the CMS or send a Drive link.';

// ---------- buttons ----------

const RESTART = {
	rewrite: { restart_from: 'write', text: 'Rewriting the draft…' },
	retranslate: { restart_from: 'translate', text: 'Translating again…' },
	retry: { restart_from: null, text: 'Retrying the failed step…' },
	restart: { restart_from: 'transcribe', text: 'Starting over from the transcription…' },
};

async function onButton(q) {
	const chatId = q.message?.chat?.id;
	if (!allowed(chatId)) return tg.answerCallback(q.id, 'This chat is not allowed to control the bot.');
	const [action, rawId, arg] = String(q.data || '').split(':');
	const id = Number(rawId);
	const who = q.from?.first_name || 'someone';
	if (!id) return tg.answerCallback(q.id, 'Unknown post.');

	if (action === 'approve') {
		await updatePost(id, { status: 'approved' });
		await tg.clearButtons(chatId, q.message.message_id);
		await say(chatId, `✅ <b>#${id}</b> approved by ${tg.esc(who)}. Publishing…`);
		return tg.answerCallback(q.id, 'Publishing…');
	}
	if (action === 'revise') {
		await say(chatId, `✏️ <b>#${id}</b> What should change? Reply to this message.`, { forceReply: true });
		return tg.answerCallback(q.id);
	}
	if (RESTART[action]) {
		await updatePost(id, { status: 'retry', restart_from: RESTART[action].restart_from });
		await say(chatId, `🔁 <b>#${id}</b> ${RESTART[action].text} (asked by ${tg.esc(who)})`);
		return tg.answerCallback(q.id, RESTART[action].text);
	}
	if (action === 'models') {
		const [post, s] = await Promise.all([getPost(id), getSettings()]);
		const llm = s.llm_choices?.length ? s.llm_choices : DEFAULT_LLM_CHOICES;
		const stt = s.stt_choices?.length ? s.stt_choices : DEFAULT_STT_CHOICES;
		const curLlm = post.llm_model || s.model;
		const curStt = post.stt_model || s.stt_model;
		const mark = (v, cur) => (v === cur ? '✓ ' : '');
		await say(chatId, `🤖 <b>#${id}</b> Pick the AI model (writing and translation) or the speech-to-text model for this post:`, {
			buttons: [
				...llm.slice(0, 8).map((m, i) => [{ text: `${mark(m, curLlm)}AI: ${m}`, data: `llm:${id}:${i}` }]),
				...stt.slice(0, 5).map((m, i) => [{ text: `${mark(m, curStt)}STT: ${m}`, data: `stt:${id}:${i}` }]),
			],
		});
		return tg.answerCallback(q.id);
	}
	if (action === 'llm' || action === 'stt') {
		const s = await getSettings();
		const list = action === 'llm' ? (s.llm_choices?.length ? s.llm_choices : DEFAULT_LLM_CHOICES) : (s.stt_choices?.length ? s.stt_choices : DEFAULT_STT_CHOICES);
		const model = list[Number(arg)];
		if (!model) return tg.answerCallback(q.id, 'That choice is no longer in the list.');
		await updatePost(id, action === 'llm' ? { llm_model: model } : { stt_model: model });
		await tg.clearButtons(chatId, q.message.message_id);
		const next = action === 'llm'
			? [[{ text: '🔁 Retry the failed step', data: `retry:${id}` }], [{ text: '🔁 Rewrite', data: `rewrite:${id}` }, { text: '🌐 Re-translate', data: `retranslate:${id}` }]]
			: [[{ text: '🔄 Transcribe again with it', data: `restart:${id}` }]];
		await say(chatId, `🤖 <b>#${id}</b> ${action === 'llm' ? 'AI' : 'Speech-to-text'} model set to <code>${tg.esc(model)}</code>. Run it now?`, { buttons: next });
		return tg.answerCallback(q.id, `Model: ${model}`);
	}
	return tg.answerCallback(q.id, 'Unknown action.');
}

// ---------- messages ----------

function attachmentOf(m) {
	if (m.document) return { kind: 'document', ...m.document };
	if (m.audio) return { kind: 'recording', ...m.audio, file_name: m.audio.file_name || 'audio.mp3' };
	if (m.voice) return { kind: 'recording', ...m.voice, file_name: 'voice.ogg', mime_type: m.voice.mime_type || 'audio/ogg' };
	if (m.video) return { kind: 'recording', ...m.video, file_name: m.video.file_name || 'video.mp4' };
	if (m.video_note) return { kind: 'recording', ...m.video_note, file_name: 'video-note.mp4', mime_type: 'video/mp4' };
	return null;
}

async function startPost(chatId, fields, from) {
	const post = await createPost({ title: fields.title || 'From Telegram', ...fields });
	await say(chatId, `🆕 <b>#${post.id}</b> created from ${from}. Updates for each step will follow here.`);
}

async function onFile(m, file, replyTo) {
	const chatId = m.chat.id;
	const name = file.file_name || 'file';
	if ((file.file_size || 0) > TG_MAX_DOWNLOAD) {
		return say(chatId, `That file is ${(file.file_size / 1024 / 1024).toFixed(0)} MB. Telegram only lets bots download up to 20 MB: upload it in the CMS, or send a Google Drive link.`);
	}

	// An edited draft: post-<id>.<lang>.md (or any .md sent as a reply to a draft file)
	const draft = parseDraftFilename(name) || (name.endsWith('.md') && parseDraftFilename(m.reply_to_message?.document?.file_name));
	if (draft) {
		const text = (await tg.downloadTelegramFile(file.file_id)).toString('utf8');
		await updatePost(draft.id, parseDraftFile(text, draft.lang));
		return say(chatId, `✅ <b>#${draft.id}</b> ${LANG_NAME[draft.lang]} draft updated from your file. Tap ✅ Publish on the review message when it's ready.`);
	}

	const isText = file.kind === 'document' && isTranscriptFile(name, file.mime_type);
	const isMedia = file.kind === 'recording' || /^(audio|video)\//.test(file.mime_type || '');
	if (!isText && !isMedia) return say(chatId, `I can't use "${tg.esc(name)}". Send a recording, a transcript file (txt, md, srt, vtt, docx, pdf) or a Google Drive link.`);

	const buffer = await tg.downloadTelegramFile(file.file_id);
	const fileId = await uploadFile(name, buffer, file.mime_type || 'application/octet-stream', `Telegram: ${name}`);
	const field = isText ? { transcript_file: fileId } : { audio: fileId };

	if (replyTo) {
		// Attach to an existing post and redo it from the transcription.
		await updatePost(replyTo, { ...field, transcript: null, status: 'retry', restart_from: 'transcribe' });
		return say(chatId, `📎 <b>#${replyTo}</b> new ${isText ? 'transcript file' : 'recording'} attached. Starting over from the transcription…`);
	}
	return startPost(chatId, { ...field, title: m.caption || path.parse(name).name }, isText ? 'a transcript file' : 'a recording');
}

async function onMessage(m) {
	const chatId = m.chat.id;
	if (!allowed(chatId)) {
		if (/^\/start/.test(m.text || '')) await say(chatId, `This chat is not connected. Its chat id is <code>${chatId}</code>; add it to TELEGRAM_CHAT_ID on the server.`);
		return;
	}
	const reply = m.reply_to_message;
	const replyTo = postIdIn(reply?.text || reply?.caption) || parseDraftFilename(reply?.document?.file_name)?.id || null;

	const file = attachmentOf(m);
	if (file) return onFile(m, file, replyTo);

	const text = (m.text || '').trim();
	if (!text) return;
	if (/^\/(start|help)\b/.test(text)) return say(chatId, HELP);

	if (replyTo) {
		await updatePost(replyTo, { feedback: text, status: 'revise' });
		return say(chatId, `✏️ <b>#${replyTo}</b> Got it. Revising the draft with your feedback…`);
	}
	const url = text.match(/https?:\/\/\S+/)?.[0];
	if (url) {
		const title = text.replace(url, '').trim();
		return startPost(chatId, { recording_url: url, title: title || undefined }, 'a link');
	}
	return say(chatId, 'Send a recording, a transcript file or a Google Drive link to start a new post, or reply to a post\'s message to give feedback. /help');
}

export async function handleUpdate(update) {
	try {
		if (update.callback_query) return await onButton(update.callback_query);
		if (update.message) return await onMessage(update.message);
	} catch (e) {
		console.error('telegram update failed:', e);
		const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
		if (chatId && allowed(chatId)) await say(chatId, `⚠️ That didn't work:\n<pre>${tg.esc(e.message)}</pre>`);
		if (update.callback_query) await tg.answerCallback(update.callback_query.id, 'Error, see the chat.');
	}
}
