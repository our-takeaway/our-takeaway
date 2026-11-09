import { FormData } from 'undici';
import { slowFetch } from './http.js';

// Minimal Telegram Bot API client. Messages go to every chat in TELEGRAM_CHAT_ID
// (comma-separated, e.g. your group). Only those chats may control the bot.

const token = () => process.env.TELEGRAM_BOT_TOKEN || '';
const api = (method) => `${(process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')}/bot${token()}/${method}`;
const fileUrl = (path) => `${(process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')}/file/bot${token()}/${path}`;

export const chats = () => (process.env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
export const enabled = () => Boolean(token() && chats().length);
export const MAX_TEXT = 3800; // Telegram allows 4096; keep room for the header

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function call(method, params, form) {
	const res = await slowFetch(api(method), form
		? { method: 'POST', body: form }
		: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
	const json = await res.json().catch(() => ({}));
	if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description || res.status}`);
	return json.result;
}

// buttons: [[{ text, data } | { text, url }]]
const keyboard = (buttons) =>
	buttons?.length
		? { inline_keyboard: buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data }))) }
		: undefined;

export async function sendText(text, { buttons, forceReply, chatId } = {}) {
	if (!enabled() && !chatId) return [];
	const targets = chatId ? [chatId] : chats();
	const sent = [];
	for (const chat of targets) {
		try {
			sent.push(await call('sendMessage', {
				chat_id: chat,
				text,
				parse_mode: 'HTML',
				disable_web_page_preview: true,
				reply_markup: forceReply ? { force_reply: true, input_field_placeholder: 'Write here…' } : keyboard(buttons),
			}));
		} catch (e) {
			console.error('telegram:', e.message);
		}
	}
	return sent;
}

export async function sendDocument(filename, content, { caption, buttons, chatId } = {}) {
	if (!enabled() && !chatId) return [];
	const sent = [];
	for (const chat of chatId ? [chatId] : chats()) {
		const form = new FormData();
		form.append('chat_id', String(chat));
		if (caption) {
			form.append('caption', caption.slice(0, 1000));
			form.append('parse_mode', 'HTML');
		}
		if (buttons) form.append('reply_markup', JSON.stringify(keyboard(buttons)));
		form.append('document', new Blob([content], { type: 'text/plain; charset=utf-8' }), filename);
		try {
			sent.push(await call('sendDocument', null, form));
		} catch (e) {
			console.error('telegram:', e.message);
		}
	}
	return sent;
}

export async function sendPhoto(buffer, filename, { caption, chatId } = {}) {
	if (!enabled() && !chatId) return [];
	const sent = [];
	for (const chat of chatId ? [chatId] : chats()) {
		const form = new FormData();
		form.append('chat_id', String(chat));
		if (caption) {
			form.append('caption', caption.slice(0, 1000));
			form.append('parse_mode', 'HTML');
		}
		form.append('photo', new Blob([buffer], { type: 'image/png' }), filename);
		try {
			sent.push(await call('sendPhoto', null, form));
		} catch (e) {
			// very tall images are refused as photos; send them as a file instead
			console.error('telegram photo:', e.message);
			sent.push(...(await sendDocument(filename, buffer, { caption, chatId: chat })));
		}
	}
	return sent;
}

// Long text: send the start as a message and the whole thing as a file.
export async function sendLong(header, body, filename, opts = {}) {
	if (header.length + body.length <= MAX_TEXT) return sendText(`${header}\n\n${body}`, opts);
	await sendText(`${header}\n\n${body.slice(0, 1500)}…\n\n<i>Full text in the attached file.</i>`);
	return sendDocument(filename, body.replace(/<\/?[a-z][^>]*>/g, ''), opts);
}

export const answerCallback = (id, text) => call('answerCallbackQuery', { callback_query_id: id, text: text?.slice(0, 190) }).catch(() => {});
export const clearButtons = (chatId, messageId) =>
	call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});

// Edit a message in place. Resolves true when the message now shows this text
// (also when nothing changed), false when it can't be edited (deleted, too old…).
export async function editText(chatId, messageId, text, buttons) {
	try {
		await call('editMessageText', {
			chat_id: chatId,
			message_id: messageId,
			text,
			parse_mode: 'HTML',
			disable_web_page_preview: true,
			reply_markup: keyboard(buttons) ?? { inline_keyboard: [] },
		});
		return true;
	} catch (e) {
		if (/not modified/i.test(e.message)) return true;
		console.error('telegram:', e.message);
		return false;
	}
}

export const deleteMessage = (chatId, messageId) =>
	call('deleteMessage', { chat_id: chatId, message_id: messageId }).then(() => true, () => false);

export async function downloadTelegramFile(fileId) {
	const file = await call('getFile', { file_id: fileId });
	const res = await slowFetch(fileUrl(file.file_path));
	if (!res.ok) throw new Error(`Could not download the file from Telegram (${res.status}).`);
	return Buffer.from(await res.arrayBuffer());
}

export async function setWebhook(url, secret) {
	await call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
	// the "/" menu in Telegram
	await call('setMyCommands', {
		commands: [
			{ command: 'posts', description: 'Every post; open its card' },
			{ command: 'post', description: 'Open one post, e.g. /post 12' },
			{ command: 'settings', description: 'Default models, prompts, names and terms' },
			{ command: 'help', description: 'How the bot works' },
		],
	}).catch((e) => console.error('telegram commands:', e.message));
}
