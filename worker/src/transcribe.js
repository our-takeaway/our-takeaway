import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.js';

// Optional step: only used when a post has an audio file and "transcribe with
// Whisper" is ticked. The default path is a transcript you made yourself for free.

const cfg = {
	directusUrl: (process.env.DIRECTUS_URL || '').replace(/\/$/, ''),
	directusToken: process.env.DIRECTUS_TOKEN || '',
	baseUrl: (process.env.TRANSCRIBE_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
	apiKey: process.env.TRANSCRIBE_API_KEY || '',
	model: process.env.TRANSCRIBE_MODEL || 'whisper-large-v3',
	language: process.env.TRANSCRIBE_LANGUAGE || 'fa',
	prompt: process.env.TRANSCRIBE_PROMPT || '',
	chunkSeconds: Number(process.env.TRANSCRIBE_CHUNK_SECONDS || 1200),
};

async function downloadFromDirectus(fileId, dest) {
	if (!/^[\w-]+$/.test(fileId)) throw new Error('bad file id');
	const res = await fetch(`${cfg.directusUrl}/assets/${fileId}`, {
		headers: { Authorization: `Bearer ${cfg.directusToken}` },
	});
	if (!res.ok) throw new Error(`could not download file ${fileId} from Directus (${res.status})`);
	await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

// Small mono Opus chunks keep every request under the ~25MB API upload limit.
async function splitAudio(file, outDir) {
	await run('ffmpeg', [
		'-hide_banner', '-loglevel', 'error', '-y',
		'-i', file,
		'-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k',
		'-f', 'segment', '-segment_time', String(cfg.chunkSeconds), '-reset_timestamps', '1',
		path.join(outDir, 'part%03d.ogg'),
	], { timeoutMs: 30 * 60 * 1000 });
	return (await fs.readdir(outDir)).filter((f) => f.startsWith('part')).sort().map((f) => path.join(outDir, f));
}

async function transcribeChunk(file, previousText) {
	const form = new FormData();
	form.append('file', new Blob([await fs.readFile(file)], { type: 'audio/ogg' }), path.basename(file));
	form.append('model', cfg.model);
	form.append('response_format', 'json');
	if (cfg.language) form.append('language', cfg.language);
	// The tail of the previous chunk keeps names and terms consistent across chunks.
	const prompt = [cfg.prompt, previousText.slice(-500)].filter(Boolean).join('\n');
	if (prompt) form.append('prompt', prompt);

	for (let attempt = 1; ; attempt++) {
		const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${cfg.apiKey}` },
			body: form,
		});
		if (res.ok) return ((await res.json()).text || '').trim();
		const body = await res.text();
		if ((res.status === 429 || res.status >= 500) && attempt < 4) {
			await new Promise((r) => setTimeout(r, attempt * 10_000));
			continue;
		}
		throw new Error(`transcription failed (${res.status}): ${body.slice(0, 500)}`);
	}
}

export async function transcribeFile(fileId) {
	if (!cfg.apiKey) throw new Error('TRANSCRIBE_API_KEY is not set');
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcribe-'));
	try {
		const source = path.join(dir, 'source');
		await downloadFromDirectus(fileId, source);
		const chunks = await splitAudio(source, dir);
		if (!chunks.length) throw new Error('ffmpeg found no audio in this file');
		const parts = [];
		for (const chunk of chunks) parts.push(await transcribeChunk(chunk, parts.join(' ')));
		return parts.join('\n\n');
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}
