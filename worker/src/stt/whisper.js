import fs from 'node:fs/promises';
import path from 'node:path';
import { splitAudio } from '../audio.js';
import { FormData } from 'undici';
import { slowFetch } from '../http.js';

// Whisper — the backup. Any OpenAI-compatible /audio/transcriptions endpoint
// (Groq by default). Cheaper, weaker on Persian, no speaker labels.

const cfg = () => ({
	baseUrl: (process.env.TRANSCRIBE_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
	apiKey: process.env.TRANSCRIBE_API_KEY || '',
	model: process.env.TRANSCRIBE_MODEL || 'whisper-large-v3',
});

async function transcribeChunk(file, { language, prompt }) {
	const c = cfg();
	const form = new FormData();
	form.append('file', new Blob([await fs.readFile(file)], { type: 'audio/ogg' }), path.basename(file));
	form.append('model', c.model);
	form.append('response_format', 'json');
	if (language) form.append('language', language);
	if (prompt) form.append('prompt', prompt);

	for (let attempt = 1; ; attempt++) {
		const res = await slowFetch(`${c.baseUrl}/audio/transcriptions`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${c.apiKey}` },
			body: form,
		});
		if (res.ok) return ((await res.json()).text || '').trim();
		const body = await res.text();
		if ((res.status === 429 || res.status >= 500) && attempt < 4) {
			await new Promise((r) => setTimeout(r, attempt * 10_000));
			continue;
		}
		throw new Error(`Whisper transcription failed (${res.status}): ${body.slice(0, 400)}`);
	}
}

export async function transcribeWithWhisper(audioFile, workDir, { language, keyterms = [] } = {}) {
	if (!cfg().apiKey) throw new Error('TRANSCRIBE_API_KEY is not set on the server (needed for Whisper).');
	const chunkDir = path.join(workDir, 'chunks');
	await fs.mkdir(chunkDir, { recursive: true });
	const chunks = await splitAudio(audioFile, chunkDir);
	const parts = [];
	for (const chunk of chunks) {
		// Key terms plus the end of the previous chunk keep spelling consistent.
		const prompt = [keyterms.join(', '), parts.join(' ').slice(-400)].filter(Boolean).join('\n');
		parts.push(await transcribeChunk(chunk, { language, prompt }));
	}
	return parts.join('\n\n');
}
