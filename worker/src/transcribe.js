import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractAudio } from './audio.js';
import { downloadFile, fileInfo, getPost, getSettings } from './directus.js';
import { downloadSource } from './sources.js';
import { transcribeWithElevenLabs } from './stt/elevenlabs.js';
import { transcribeWithWhisper } from './stt/whisper.js';
import { detectLanguage, extractText } from './textfile.js';

// Turn whatever the post has into a transcript. Order of preference:
//   1. a transcript file (txt, md, srt, vtt, docx, pdf) → its text
//   2. an uploaded recording (audio or video)          → voice only → speech-to-text
//   3. a Google Drive / direct link to a recording       → same
// The speech-to-text model is the post's choice, else the Writer Settings default.

export const DEFAULT_STT = 'elevenlabs:scribe_v2';

// ElevenLabs keyterm rules: ≤1000 terms, each <50 chars and ≤5 words, no <>{}[]\
function cleanKeyterms(list) {
	const seen = new Set();
	return (Array.isArray(list) ? list : [])
		.map((t) => String(t).replace(/[<>{}[\]\\]/g, ' ').replace(/\s+/g, ' ').trim())
		.filter((t) => t && t.length < 50 && t.split(' ').length <= 5 && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
		.slice(0, 1000);
}

export function parseSttModel(value) {
	const [provider, ...rest] = String(value || DEFAULT_STT).split(':');
	const model = rest.join(':');
	if (provider === 'elevenlabs') return { provider, model: model || 'scribe_v2' };
	if (provider === 'whisper') return { provider, model: model || 'whisper-large-v3' };
	throw new Error(`Unknown speech-to-text model "${value}". Use e.g. elevenlabs:scribe_v2 or whisper:whisper-large-v3.`);
}

async function transcribeRecording(source, { stt, language, keyterms }) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcribe-'));
	try {
		const file = path.join(dir, 'source');
		await downloadSource(source, file);
		const audio = await extractAudio(file, path.join(dir, 'voice.ogg'));
		await fs.rm(file, { force: true }); // free the disk before the slow part
		const opts = { model: stt.model, language, keyterms };
		return stt.provider === 'whisper'
			? await transcribeWithWhisper(audio, dir, opts)
			: await transcribeWithElevenLabs(audio, opts);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

export async function transcribePost(postId) {
	const started = Date.now();
	const [post, settings] = await Promise.all([getPost(postId), getSettings()]);
	const forced = ['fa', 'en'].includes(post.source_language) ? post.source_language : null;
	let result;

	if (post.transcript_file) {
		const info = await fileInfo(post.transcript_file);
		const text = await extractText(await downloadFile(post.transcript_file), info.filename_download, info.type);
		result = { text, language: forced || detectLanguage(text), model: `file: ${info.filename_download}`, source: 'file' };
	} else if (post.audio || post.recording_url?.trim()) {
		const stt = parseSttModel(post.stt_model || settings.stt_model || DEFAULT_STT);
		const language = forced || settings.transcription_language?.trim() || undefined;
		const keyterms = cleanKeyterms([...(settings.keyterms || []), ...(post.keyterms || [])]);
		const source = post.audio ? { fileId: post.audio } : { url: post.recording_url.trim() };
		const out = await transcribeRecording(source, { stt, language, keyterms });
		result = {
			text: out.text,
			language: forced || out.language || detectLanguage(out.text),
			model: `${stt.provider}:${stt.model}`,
			source: post.audio ? 'upload' : 'link',
		};
	} else {
		throw new Error('Nothing to transcribe: upload a recording or a transcript file, paste a Google Drive link, or paste the transcript.');
	}

	if (!result.text?.trim()) throw new Error(`The transcription came back empty (${result.model}). Is there speech in the recording?`);
	result.seconds = Math.round((Date.now() - started) / 1000);
	result.chars = result.text.length;
	console.log(`post ${postId}: transcribed with ${result.model} in ${result.seconds}s (${result.chars} chars, ${result.language})`);
	return result;
}
