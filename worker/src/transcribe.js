import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractAudio } from './audio.js';
import { downloadSource } from './sources.js';
import { transcribeWithElevenLabs } from './stt/elevenlabs.js';
import { transcribeWithWhisper } from './stt/whisper.js';

// recording (Directus upload / Drive link / URL) → voice only → text
//
// request: { fileId?, url?, provider?: 'elevenlabs' | 'whisper', language?, keyterms?: string[] }

// ElevenLabs keyterm rules: ≤1000 terms, each <50 chars and ≤5 words, no <>{}[]\
function cleanKeyterms(list) {
	const seen = new Set();
	return (Array.isArray(list) ? list : [])
		.map((t) => String(t).replace(/[<>{}[\]\\]/g, ' ').replace(/\s+/g, ' ').trim())
		.filter((t) => t && t.length < 50 && t.split(' ').length <= 5 && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
		.slice(0, 1000);
}

export async function transcribe({ fileId, url, provider = 'elevenlabs', language, keyterms }) {
	if (!fileId && !url) throw Object.assign(new Error('Send a fileId or a url.'), { status: 400 });
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcribe-'));
	const started = Date.now();
	try {
		const source = path.join(dir, 'source');
		await downloadSource({ fileId, url }, source);
		const audio = await extractAudio(source, path.join(dir, 'voice.ogg'));
		await fs.rm(source, { force: true }); // free the disk before the slow part

		const opts = { language: language?.trim() || undefined, keyterms: cleanKeyterms(keyterms) };
		const text =
			provider === 'whisper'
				? await transcribeWithWhisper(audio, dir, opts)
				: await transcribeWithElevenLabs(audio, opts);
		if (!text.trim()) throw new Error('The transcription came back empty. Is there speech in the recording?');

		console.log(`transcribed with ${provider} in ${Math.round((Date.now() - started) / 1000)}s (${text.length} chars)`);
		return text;
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}
