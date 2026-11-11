import path from 'node:path';
import { cardMessageOf, lastSpeakers, onDeleted, rememberSpeakers, showCard, speakersOf, voicesOf } from './card.js';
import { cmsSettingsLink, createPost, deletePost, getPost, getSettings, listPosts, updatePost, updateSettings, uploadFile } from './directus.js';
import { DIAGRAM_STYLES, makeDiagram, removeDiagram, sendDiagram, styleName, wordRange } from './diagram.js';
import { draftFile, draftFilename, LANG_NAME, parseDraftFile, parseDraftFilename } from './drafts.js';
import { napkinKeys } from './napkin.js';
import { DIAGRAM_PLACEHOLDERS, defaultPrompt, PROMPTS } from './prompts.js';
import * as tg from './telegram.js';
import { isTranscriptFile } from './textfile.js';

// Telegram is a full remote for the CMS. Every post has one live card (card.js);
// its buttons change the post in Directus, and Directus tells n8n, exactly as if
// you had done it in the CMS.
//
//   card buttons     publish · ask for changes · rewrite · re-translate · retry · start over ·
//                    unpublish · drafts · transcript · full error · settings (speakers & notes,
//                    language, models, delete)
//   /posts /post N   find any post and bring its card to the bottom
//   /settings        default models, reasoning effort, social language, names and terms, prompts
//   reply with text  to a card → feedback, then the AI revises the draft
//   reply with a     post-<id>.<lang>.md file → that language's draft is replaced
//   send a recording, transcript file or link → new post (caption: title, then who is who)

const TG_MAX_DOWNLOAD = 20 * 1024 * 1024; // Telegram bots can't download bigger files

export const DEFAULT_LLM_CHOICES = [
	'deepseek/deepseek-v4-flash-0731',
	'deepseek/deepseek-v4.1-flash',
	'deepseek/deepseek-v4-pro',
	'google/gemini-3.8-flash',
	'anthropic/claude-sonnet-5.5',
];
export const DEFAULT_STT_CHOICES = ['elevenlabs:scribe_v2', 'whisper:whisper-large-v3', 'whisper:whisper-large-v3-turbo'];

// file name in Telegram → Writer Settings field (writing-prompt.md → system_prompt, …)
const PROMPT_FILES = Object.fromEntries(Object.entries(PROMPTS).map(([field, p]) => [p.download, field]));
const PROMPT_BUTTON = { pw: 'system_prompt', pt: 'translation_prompt', pd: 'diagram_prompt' };
const STATUS_ICON = {
	new: '🆕', transcribing: '⏳', speakers: '🗣', writing: '⏳', translating: '⏳', revise: '🔁', retry: '🔁',
	review: '👀', approved: '🚀', publishing: '🚀', published: '🟢', archived: '🙈', error: '❌',
};
const BUSY = ['new', 'transcribing', 'writing', 'translating', 'revise', 'retry', 'approved', 'publishing'];

const postIdIn = (text) => Number(String(text || '').match(/#(\d+)\b/)?.[1]) || null;
const allowed = (chatId) => tg.chats().includes(String(chatId));
const say = (chatId, text, opts = {}) => tg.sendText(text, { ...opts, chatId });
const b = (text, data) => ({ text, data });
const llmChoices = (s) => (s.llm_choices?.length ? s.llm_choices : DEFAULT_LLM_CHOICES);
const sttChoices = (s) => (s.stt_choices?.length ? s.stt_choices : DEFAULT_STT_CHOICES);
const titleOf = (p) => p.title_fa || p.title_en || p.title || `Post ${p.id}`;

const HELP =
	'<b>Our Takeaway bot</b>\n\n' +
	'<b>Start a post:</b> send a recording (voice, audio or video up to 20 MB), a transcript file ' +
	'(txt, md, srt, vtt, docx, pdf) or a Google Drive link. The caption\'s first line becomes the title; ' +
	'put who is who on the next lines, e.g.\n<code>Speaker 1 = Sajad\nSpeaker 2 = Alireza</code>\n\n' +
	'Every post gets <b>one card</b> here that updates itself: a progress bar, each step, and the buttons that fit right now ' +
	'(publish, ask for changes, unpublish, settings…). When it needs you, the card moves to the bottom so you get a notification.\n\n' +
	'<b>Commands</b>\n' +
	'/posts — every post; tap one to open its card\n' +
	'/post 12 — open post #12\n' +
	'/settings — default models, prompts, names and terms\n' +
	'/help — this message\n\n' +
	'<b>Editing</b>\n' +
	'• 📄 Drafts sends each language as a <code>.md</code> file. Edit it and send it back as a reply (keep the file name).\n' +
	'• ✏️ Ask for changes, or reply to a card with text: the AI rewrites the draft with your feedback.\n' +
	'• Reply to a card with a new recording or transcript to redo that post from the start.\n\n' +
	'Bigger recordings: upload them in the CMS or send a Drive link.';

// Questions the bot asks with a reply box; the first character says what the answer is for.
const ASK = {
	feedback: (id, live) =>
		`✏️ #${id} What should change? Reply to this message.${live ? '\n<i>The post leaves the site until you publish it again.</i>' : ''}`,
	notes: (id, notes) =>
		`🗣 #${id} Who is who, and anything the writer should know? Reply to this message; it replaces the current notes. For example:\n` +
		`<code>Speaker 1 = Sajad\nSpeaker 2 = Alireza\nFocus on the decision about week one.</code>` +
		(notes?.trim() ? `\n\nNow:\n<code>${tg.esc(notes.trim())}</code>` : ''),
	names: (id, voices) =>
		`🎙 #${id} Who is speaking? Reply with one name per line, in this order:\n` +
		voices.map((v) => `<b>Speaker ${v.n}:</b> <i>${tg.esc(v.sample || '…')}</i>`).join('\n'),
	keyterms: (terms) =>
		'🔤 Names and terms said in every session, so the transcription spells them right. Reply with one per line (or separated by commas); it replaces the list.' +
		(terms?.length ? `\n\nNow:\n<code>${tg.esc(terms.join('\n'))}</code>` : ''),
};

// "My title\nSpeaker 1 = Sajad" → { title, notes }
function titleAndNotes(text) {
	const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
	const isNote = (l) => /speaker\s*\d+\s*[=:]/i.test(l);
	const title = lines.find((l) => !isNote(l));
	const notes = lines.filter((l) => l !== title).join('\n');
	return { title: title || undefined, notes: notes || undefined };
}

// ---------- who is speaking ----------

// "Sajad\nAlireza", "Sajad, Alireza" or "Speaker 2 = Alireza\nSpeaker 1 = Sajad" → ['Sajad', 'Alireza']
function parseNames(text) {
	const names = [];
	let next = 0;
	for (const part of String(text).split(/[\n,،]/).map((s) => s.trim()).filter(Boolean)) {
		const m = part.match(/^speaker\s*(\d+)\s*[=:]\s*(.+)$/i);
		if (m) names[Number(m[1]) - 1] = m[2].trim();
		else {
			while (names[next]) next++;
			names[next] = part.replace(/^\d+\s*[.)=:-]\s*/, '');
		}
	}
	return Array.from(names, (n) => n || '');
}

// Save "Speaker n = Name" lines into the notes (replacing older ones) and write the post.
async function nameSpeakers(id, names, who) {
	const post = await getPost(id);
	const mapping = names.map((n, i) => (n ? `Speaker ${i + 1} = ${n}` : null)).filter(Boolean);
	const rest = String(post.notes || '').split('\n').filter((l) => !/speaker\s*\d+\s*[=:]/i.test(l)).join('\n').trim();
	await updatePost(id, { notes: [...mapping, rest].filter(Boolean).join('\n'), status: 'retry', restart_from: 'write' });
	rememberSpeakers(names.filter(Boolean));
	return showCard(id, { note: `🗣 ${mapping.join(' · ')} (${who}). Writing…` });
}

// ---------- the post list ----------

async function showList(chatId, offset = 0, messageId) {
	const rows = await listPosts(offset, 11);
	const page = rows.slice(0, 10);
	const text = page.length
		? `📚 <b>Posts</b> ${offset + 1}–${offset + page.length}, newest first. Tap one to open its card.`
		: '📚 No posts yet. Send a recording, a transcript file or a Drive link to start one.';
	const buttons = page.map((p) => [b(`${STATUS_ICON[p.status] || '•'} #${p.id} ${titleOf(p)}`.slice(0, 60), `open:${p.id}`)]);
	const nav = [...(offset > 0 ? [b('⬅️ Newer', `pl:${Math.max(0, offset - 10)}`)] : []), ...(rows.length > 10 ? [b('Older ➡️', `pl:${offset + 10}`)] : [])];
	if (nav.length) buttons.push(nav);
	if (messageId && (await tg.editText(chatId, messageId, text, buttons))) return;
	await say(chatId, text, { buttons });
}

// ---------- global settings ----------

function settingsText(s) {
	const terms = Array.isArray(s.keyterms) ? s.keyterms : [];
	return [
		'⚙️ <b>Writer settings</b> (the defaults for every post)',
		'',
		`🤖 AI model: <code>${tg.esc(s.model || DEFAULT_LLM_CHOICES[0])}</code>`,
		`🧠 Reasoning effort: ${tg.esc(s.reasoning_effort || 'low')}`,
		`🎙 Speech-to-text: <code>${tg.esc(s.stt_model || DEFAULT_STT_CHOICES[0])}</code>`,
		`🔤 Names and terms: ${terms.length ? tg.esc(terms.join(', ')) : 'none'}`,
		`📣 Social posts in: ${LANG_NAME[s.social_language || 'en']}`,
		`📊 Diagrams: ${tg.esc(styleName(s.diagram_style || DIAGRAM_STYLES[0][1]))} · ${wordRange(s).totalMin}–${wordRange(s).totalMax} words a post (${wordRange(s).min}–${wordRange(s).max} per language) · ${napkinKeys().length} Napkin key(s)`,
		'',
		'<i>📄 sends a prompt as a file: edit it and send it back as a reply to replace it.</i>',
	].join('\n');
}

function settingsButtons(s) {
	return [
		[b('🤖 AI model', 'g:llm'), b('🎙 Speech model', 'g:stt')],
		[b(`🧠 Effort: ${s.reasoning_effort || 'low'}`, 'g:eff'), b(`📣 Social: ${LANG_NAME[s.social_language || 'en']}`, 'g:soc')],
		[b('🔤 Names & terms', 'g:kt')],
		[b('📊 Diagram style', 'g:dst'), b(`📊 Words: ${wordRange(s).totalMin}–${wordRange(s).totalMax}`, 'g:dw')],
		[b('📄 Writing prompt', 'g:pw'), b('📄 Translation prompt', 'g:pt')],
		[b('📄 Diagram prompt', 'g:pd')],
		[{ text: '🔗 Open in CMS', url: cmsSettingsLink() }],
	];
}

async function showSettings(chatId, messageId, s) {
	s ??= await getSettings();
	if (messageId && (await tg.editText(chatId, messageId, settingsText(s), settingsButtons(s)))) return;
	await say(chatId, settingsText(s), { buttons: settingsButtons(s) });
}

async function onGlobal(q, sub, arg) {
	const chatId = q.message.chat.id;
	const msgId = q.message.message_id;
	const s = await getSettings();
	const menu = (patch, toast) => (patch ? updateSettings(patch) : Promise.resolve(s))
		.then((next) => showSettings(chatId, msgId, { ...s, ...next }))
		.then(() => tg.answerCallback(q.id, toast));
	const pick = (title, rows) =>
		tg.editText(chatId, msgId, `${settingsText(s)}\n\n<b>${title}</b>`, [...rows, [b('⬅️ Back', 'g:menu')]]).then(() => tg.answerCallback(q.id));
	const mark = (v, cur) => (v === cur ? '✓ ' : '');

	switch (sub) {
		case 'menu':
			return menu();
		case 'llm': {
			const list = llmChoices(s);
			if (arg === undefined) return pick('Default AI model', list.slice(0, 8).map((m, i) => [b(`${mark(m, s.model)}${m}`, `g:llm:${i}`)]));
			return list[Number(arg)] ? menu({ model: list[Number(arg)] }, `AI model: ${list[Number(arg)]}`) : menu();
		}
		case 'stt': {
			const list = sttChoices(s);
			if (arg === undefined) return pick('Default speech-to-text model', list.slice(0, 6).map((m, i) => [b(`${mark(m, s.stt_model)}${m}`, `g:stt:${i}`)]));
			return list[Number(arg)] ? menu({ stt_model: list[Number(arg)] }, `Speech model: ${list[Number(arg)]}`) : menu();
		}
		case 'eff':
			if (!arg) return pick('Reasoning effort (low leaves more room for the text)', [['low', 'medium', 'high'].map((e) => b(`${mark(e, s.reasoning_effort || 'low')}${e}`, `g:eff:${e}`))]);
			return menu({ reasoning_effort: arg }, `Reasoning effort: ${arg}`);
		case 'soc':
			if (!arg) return pick('Language of the X and Reddit posts', [[b(`${mark('en', s.social_language || 'en')}English`, 'g:soc:en'), b(`${mark('fa', s.social_language)}فارسی`, 'g:soc:fa')]]);
			return menu({ social_language: arg }, 'Saved');
		case 'kt':
			await say(chatId, ASK.keyterms(Array.isArray(s.keyterms) ? s.keyterms : []), { forceReply: true });
			return tg.answerCallback(q.id);
		case 'dst': {
			const cur = s.diagram_style || DIAGRAM_STYLES[0][1];
			if (arg === undefined) return pick('Napkin style for diagrams', DIAGRAM_STYLES.map(([name, sid], i) => [b(`${mark(sid, cur)}${name}`, `g:dst:${i}`)]));
			const chosen = DIAGRAM_STYLES[Number(arg)];
			return chosen ? menu({ diagram_style: chosen[1] }, `Style: ${chosen[0]}`) : menu();
		}
		case 'dw': {
			// ranges per post, both languages together (each language gets half)
			const RANGES = [[40, 100], [50, 120], [80, 200], [120, 300]];
			const { totalMin, totalMax } = wordRange(s);
			if (!arg) {
				return pick('Words in the diagram per post, both languages together (each gets half). Napkin charges about 1 credit per word, so this is roughly the credits per post.',
					[RANGES.map(([lo, hi], i) => b(`${lo === totalMin && hi === totalMax ? '✓ ' : ''}${lo}–${hi}`, `g:dw:${i}`))]);
			}
			const [lo, hi] = RANGES[Number(arg)] || RANGES[1];
			return menu({ diagram_words_min: lo, diagram_words: hi }, `${lo}–${hi} words a post`);
		}
		case 'pw':
		case 'pt':
		case 'pd': {
			const field = PROMPT_BUTTON[sub];
			const p = PROMPTS[field];
			const custom = Boolean(s[field]?.trim()) && s[field].trim() !== defaultPrompt(field).trim();
			const holders = field === 'diagram_prompt'
				? `\nPlaceholders, filled in for each post: ${Object.entries(DIAGRAM_PLACEHOLDERS).map(([k, v]) => `<code>{{${k}}}</code> ${v}`).join(', ')}.`
				: '';
			await tg.sendDocument(p.download, s[field]?.trim() || defaultPrompt(field), {
				chatId,
				caption: `📄 <b>${p.name}</b>${custom ? ' (edited)' : ' (default)'}. Edit the file and send it back as a reply (keep the file name) to replace it.${holders}`,
				buttons: custom ? [[b('♻️ Go back to the default', `g:rst:${sub}`)]] : undefined,
			});
			return tg.answerCallback(q.id, 'Sent below');
		}
		case 'rst': {
			const field = PROMPT_BUTTON[arg];
			if (!field) return tg.answerCallback(q.id, 'Unknown prompt.');
			await updateSettings({ [field]: defaultPrompt(field) });
			await tg.clearButtons(chatId, msgId);
			await say(chatId, `♻️ ${PROMPTS[field].name} is back to the default (${tg.esc(q.from?.first_name || 'someone')}). It is used from the next run on.`);
			return tg.answerCallback(q.id, 'Back to the default');
		}
		default:
			return tg.answerCallback(q.id, 'Unknown setting.');
	}
}

// ---------- card buttons ----------

// buttons from cards sent before the cards existed
const ALIAS = { approve: 'pub', revise: 'rev', rewrite: 'rw', retranslate: 'rt', models: 'mdl' };
const RESTART = {
	rw: ['write', 'Rewriting the draft'],
	rt: ['translate', 'Translating again'],
	retry: [null, 'Retrying the failed step'],
	restart: ['transcribe', 'Starting over from the transcription'],
};

async function onButton(q) {
	const chatId = q.message?.chat?.id;
	const msgId = q.message?.message_id;
	if (!allowed(chatId)) return tg.answerCallback(q.id, 'This chat is not allowed to control the bot.');
	const [raw, rawId, arg] = String(q.data || '').split(':');
	if (raw === 'g') return onGlobal(q, rawId, arg);
	if (raw === 'pl') {
		await showList(chatId, Number(rawId) || 0, msgId);
		return tg.answerCallback(q.id);
	}

	const action = ALIAS[raw] || raw;
	const id = Number(rawId);
	if (!id) return tg.answerCallback(q.id, 'Unknown post.');
	const who = q.from?.first_name || 'someone';
	const here = { chatId, messageId: action === 'open' ? cardMessageOf(id, chatId) : msgId };
	const post = await getPost(id).catch(() => null);
	if (!post) {
		if (action !== 'open') await tg.editText(chatId, msgId, `🗑 <b>#${id}</b> no longer exists.`, []);
		return tg.answerCallback(q.id, 'This post no longer exists.');
	}
	const live = post.status === 'published';
	const busy = BUSY.includes(post.status);
	const card = (opts, toast) => showCard(id, { ...here, ...opts }).then(() => tg.answerCallback(q.id, toast));

	switch (action) {
		case 'ref':
		case 'back':
			return card({});
		case 'open':
			return card({ repost: true });
		case 'pub':
			if (live) return tg.answerCallback(q.id, 'Already live.');
			if (busy) return tg.answerCallback(q.id, 'Still working on it, wait for the review.');
			await updatePost(id, { status: 'approved' });
			return card({ note: `🚀 Publishing… (${who})` }, 'Publishing…');
		case 'unpub':
			if (post.status !== 'published') return card({}, 'It is not on the site.');
			if (arg !== 'ok') return card({ view: { confirm: 'unpub' } });
			await updatePost(id, { status: 'archived' });
			return card({ note: `🙈 Taking it off the site… (${who})` }, 'Unpublishing…');
		case 'rev':
			if (busy) return tg.answerCallback(q.id, 'Still working on it, wait a moment.');
			await say(chatId, ASK.feedback(id, live), { forceReply: true });
			return tg.answerCallback(q.id, 'Reply with what should change');
		case 'rw':
		case 'rt':
		case 'retry':
		case 'restart': {
			if (busy) return tg.answerCallback(q.id, 'Still working on it, wait a moment.');
			if (live && arg !== 'ok') return card({ view: { confirm: action } });
			const [from, text] = RESTART[action];
			await updatePost(id, { status: 'retry', restart_from: from });
			return card({ note: `🔁 ${text}… (${who})` }, `${text}…`);
		}
		case 'del':
			if (arg !== 'ok') return card({ view: { confirm: 'del' } });
			await deletePost(id);
			await onDeleted(id, who);
			return tg.answerCallback(q.id, 'Deleted.');
		case 'drafts': {
			const langs = ['fa', 'en'].filter((l) => post[`body_${l}`]?.trim());
			if (!langs.length) return tg.answerCallback(q.id, 'No draft yet.');
			for (const l of langs) {
				await tg.sendDocument(draftFilename(id, l), draftFile(post, l), {
					chatId,
					caption: `📄 <b>#${id}</b> ${LANG_NAME[l]} draft. To change it, edit the file and send it back as a reply (keep the file name).`,
				});
			}
			return tg.answerCallback(q.id, 'Drafts sent below');
		}
		case 'tr':
			if (!post.transcript) return tg.answerCallback(q.id, 'No transcript yet.');
			await tg.sendDocument(`post-${id}-transcript.txt`, post.transcript, { chatId, caption: `📜 <b>#${id}</b> transcript` });
			return tg.answerCallback(q.id, 'Sent below');
		case 'err':
			if (!post.error_message) return tg.answerCallback(q.id, 'No error on this post.');
			await tg.sendLong(`📋 <b>#${id}</b> full error`, `<pre>${tg.esc(post.error_message)}</pre>`, `post-${id}-error.txt`, { chatId });
			return tg.answerCallback(q.id, 'Sent below');
		case 'spn':
		case 'spt':
		case 'spw': {
			if (post.status !== 'speakers') return card({}, 'This post is not waiting for names any more.');
			if (action === 'spw') {
				await updatePost(id, { status: 'retry', restart_from: 'write' });
				return card({ note: `👥 Writing it as “we” (${who})…` }, 'Writing…');
			}
			if (action === 'spt') {
				await say(chatId, ASK.names(id, voicesOf(post.transcript)), { forceReply: true });
				return tg.answerCallback(q.id, 'Reply with the names');
			}
			const names = arg === '1' ? [...lastSpeakers()].reverse() : lastSpeakers();
			await nameSpeakers(id, names, who);
			return tg.answerCallback(q.id, 'Writing…');
		}
		case 'dg':
			if (post.diagram_status === 'making') return tg.answerCallback(q.id, 'Already making it…');
			if (!napkinKeys().length) return tg.answerCallback(q.id, 'No Napkin API key on the server (NAPKIN_API_KEY_1).');
			tg.answerCallback(q.id, 'Making the diagram…');
			return makeDiagram(id, who);
		case 'dgn':
			await updatePost(id, { diagram_status: 'no' });
			return card({ note: `🚫 No diagram for this post (${who})` }, 'No diagram');
		case 'dgs':
			if (!post.diagram?.fa?.file && !post.diagram?.en?.file) return tg.answerCallback(q.id, 'There is no diagram yet.');
			tg.answerCallback(q.id, 'Sending…');
			return sendDiagram(id, chatId);
		case 'dgx':
			tg.answerCallback(q.id, 'Removing…');
			return removeDiagram(id, who);
		case 'set':
			return card({ view: 'settings' });
		case 'lang':
			if (!arg) return card({ view: 'language' });
			await updatePost(id, { source_language: arg === 'auto' ? null : arg });
			return card({ view: 'settings', note: `🌐 Session language: ${arg === 'auto' ? 'auto' : LANG_NAME[arg]} (${who})` }, 'Saved');
		case 'spk':
			await say(chatId, ASK.notes(id, post.notes), { forceReply: true });
			return tg.answerCallback(q.id, 'Reply with the notes');
		case 'mdl': {
			const s = await getSettings();
			return card({ view: { models: [llmChoices(s), sttChoices(s), s] } });
		}
		case 'llm':
		case 'stt': {
			const s = await getSettings();
			const model = (action === 'llm' ? llmChoices(s) : sttChoices(s))[Number(arg)];
			if (!model) return tg.answerCallback(q.id, 'That choice is no longer in the list.');
			await updatePost(id, action === 'llm' ? { llm_model: model } : { stt_model: model });
			const use = action === 'llm' ? '🔁 Rewrite or Retry to use it' : '🔄 Start over to use it';
			return card({ note: `🤖 ${action === 'llm' ? 'AI' : 'Speech'} model → ${model} (${who}). ${use}.` }, `Model: ${model}`);
		}
		default:
			return tg.answerCallback(q.id, 'Unknown action.');
	}
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

async function startPost(fields, from, who) {
	const post = await createPost({ ...fields, title: fields.title || 'From Telegram' });
	rememberSpeakers(speakersOf(fields.notes));
	await showCard(post.id, { repost: true, note: `🆕 Started from ${from} by ${who}` });
}

// The question and its answer have done their job once the card shows the result.
const tidy = (chatId, ...ids) => Promise.all(ids.filter(Boolean).map((id) => tg.deleteMessage(chatId, id)));

async function onFile(m, file, replyTo, who) {
	const chatId = m.chat.id;
	const name = file.file_name || 'file';
	if ((file.file_size || 0) > TG_MAX_DOWNLOAD) {
		return say(chatId, `That file is ${(file.file_size / 1024 / 1024).toFixed(0)} MB. Telegram only lets bots download up to 20 MB: upload it in the CMS, or send a Google Drive link.`);
	}

	// An edited prompt: writing-prompt.md / translation-prompt.md
	const promptField = PROMPT_FILES[name] || PROMPT_FILES[m.reply_to_message?.document?.file_name];
	if (promptField && name.endsWith('.md')) {
		const text = (await tg.downloadTelegramFile(file.file_id)).toString('utf8').replace(/^﻿/, '').trim();
		if (!text) return say(chatId, 'That file is empty, so the prompt was not changed.');
		await updateSettings({ [promptField]: text });
		// the diagram prompt is told the word range through {{min}} / {{max}}
		const missing = promptField === 'diagram_prompt' ? ['min', 'max'].filter((k) => !text.includes(`{{${k}}}`)) : [];
		const warn = missing.length
			? `\n⚠️ It has no ${missing.map((k) => `<code>{{${k}}}</code>`).join(' / ')}, so the AI is not told the word range (the bot still checks it).`
			: '';
		return say(chatId, `✅ ${PROMPTS[promptField].name} replaced (${text.length.toLocaleString('en')} characters) by ${tg.esc(who)}. It is used from the next run on.${warn}`);
	}

	// An edited draft: post-<id>.<lang>.md (or any .md sent as a reply to a draft file)
	const draft = parseDraftFilename(name) || (name.endsWith('.md') && parseDraftFilename(m.reply_to_message?.document?.file_name));
	if (draft) {
		const text = (await tg.downloadTelegramFile(file.file_id)).toString('utf8');
		await updatePost(draft.id, parseDraftFile(text, draft.lang));
		return showCard(draft.id, { note: `📝 ${LANG_NAME[draft.lang]} draft updated from a file (${who})` });
	}

	const isText = file.kind === 'document' && isTranscriptFile(name, file.mime_type);
	const isMedia = file.kind === 'recording' || /^(audio|video)\//.test(file.mime_type || '');
	if (!isText && !isMedia) return say(chatId, `I can't use "${tg.esc(name)}". Send a recording, a transcript file (txt, md, srt, vtt, docx, pdf) or a Google Drive link.`);

	const buffer = await tg.downloadTelegramFile(file.file_id);
	const fileId = await uploadFile(name, buffer, file.mime_type || 'application/octet-stream', `Telegram: ${name}`);
	const field = isText ? { transcript_file: fileId } : { audio: fileId };
	const kind = isText ? 'transcript file' : 'recording';

	if (replyTo) {
		// Attach to an existing post and redo it from the transcription.
		await updatePost(replyTo, { ...field, transcript: null, status: 'retry', restart_from: 'transcribe' });
		return showCard(replyTo, { note: `📎 New ${kind} from ${who}. Starting over…` });
	}
	const { title, notes } = titleAndNotes(m.caption);
	return startPost({ ...field, title: title || path.parse(name).name, notes }, `a ${kind}`, who);
}

async function onMessage(m) {
	const chatId = m.chat.id;
	if (!allowed(chatId)) {
		if (/^\/start/.test(m.text || '')) await say(chatId, `This chat is not connected. Its chat id is <code>${chatId}</code>; add it to TELEGRAM_CHAT_ID on the server.`);
		return;
	}
	const who = m.from?.first_name || 'someone';
	const reply = m.reply_to_message;
	const replyText = reply?.text || reply?.caption || '';
	const replyTo = postIdIn(replyText) || parseDraftFilename(reply?.document?.file_name)?.id || null;

	const file = attachmentOf(m);
	if (file) return onFile(m, file, replyTo, who);

	const text = (m.text || '').trim();
	if (!text) return;

	// commands
	const cmd = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
	if (cmd) {
		const [, name, rest] = cmd;
		if (name === 'start' || name === 'help') return say(chatId, HELP);
		if (name === 'posts') return showList(chatId, 0);
		if (name === 'settings') return showSettings(chatId);
		if (name === 'post') {
			const id = Number(rest.replace('#', '').trim());
			if (!id) return say(chatId, 'Which post? For example: <code>/post 12</code>');
			const exists = await getPost(id).catch(() => null);
			if (!exists) return say(chatId, `There is no post #${id}.`);
			return showCard(id, { chatId, messageId: cardMessageOf(id, chatId), repost: true });
		}
		return say(chatId, 'Unknown command. /help');
	}

	// answers to the bot's questions
	if (reply?.from?.is_bot && replyText.startsWith('🔤')) {
		const terms = text.split(/[\n,،]/).map((t) => t.trim()).filter(Boolean);
		await updateSettings({ keyterms: terms });
		await tidy(chatId, reply.message_id, m.message_id);
		return say(chatId, `🔤 Names and terms saved (${terms.length}) by ${tg.esc(who)}.`);
	}
	if (replyTo && replyText.startsWith('🎙')) {
		const post = await getPost(replyTo);
		if (post.status !== 'speakers') return say(chatId, `<b>#${replyTo}</b> is not waiting for names any more. Use ⚙️ Settings → 🗣 Speakers & notes to change them.`);
		const names = parseNames(text);
		if (!names.some(Boolean)) return say(chatId, 'I could not read any names. Reply with one name per line.');
		await tidy(chatId, reply.message_id, m.message_id);
		return nameSpeakers(replyTo, names, who);
	}
	if (replyTo && replyText.startsWith('🗣')) {
		const post = await updatePost(replyTo, { notes: text });
		rememberSpeakers(speakersOf(text));
		await tidy(chatId, reply.message_id, m.message_id);
		const later = ['review', 'published', 'archived', 'error'].includes(post.status) ? ' 🔁 Rewrite to use them.' : '';
		return showCard(replyTo, { note: `🗣 Notes updated (${who}).${later}` });
	}
	if (replyTo) {
		const post = await getPost(replyTo);
		// replying to "who is speaking?" with names
		if (post.status === 'speakers') {
			const names = parseNames(text);
			if (!names.some(Boolean)) return say(chatId, 'Reply with the speakers\' names, one per line, in order.');
			return nameSpeakers(replyTo, names, who);
		}
		if (BUSY.includes(post.status)) return say(chatId, `<b>#${replyTo}</b> is still being worked on. Send your feedback once it is ready for review.`);
		await updatePost(replyTo, { feedback: text, status: 'revise' });
		if (replyText.startsWith('✏️')) await tidy(chatId, reply.message_id, m.message_id);
		const short = text.length > 80 ? `${text.slice(0, 77)}…` : text;
		return showCard(replyTo, { note: `✏️ Revising with ${who}'s feedback: “${short}”` });
	}

	// a link starts a new post
	const url = text.match(/https?:\/\/\S+/)?.[0];
	if (url) {
		const { title, notes } = titleAndNotes(text.replace(url, ''));
		return startPost({ recording_url: url, title, notes }, 'a link', who);
	}
	return say(chatId, 'Send a recording, a transcript file or a Google Drive link to start a new post, reply to a card to give feedback, or try /posts. /help');
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
