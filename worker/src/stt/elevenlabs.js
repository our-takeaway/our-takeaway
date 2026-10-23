import fs from 'node:fs/promises';
import path from 'node:path';
import { FormData } from 'undici';
import { slowFetch } from '../http.js';

// ElevenLabs Scribe v2 — the default. Handles up to 10 hours in one request,
// separates speakers, and accepts key terms so names and jargon come out right.
// Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/convert

const BASE = (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/$/, '');

const clock = (s) => {
	const t = Math.floor(s ?? 0);
	const h = Math.floor(t / 3600);
	const mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0');
	const ss = String(t % 60).padStart(2, '0');
	return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

// Turn word-level output into readable turns: "[03:12] Speaker 2: …"
export function toTurns(result) {
	const words = (result.words || []).filter((w) => w.type === 'word' || w.type === 'spacing');
	if (!words.some((w) => w.speaker_id)) return (result.text || '').trim();

	const names = new Map();
	const label = (id) => {
		if (!names.has(id)) names.set(id, `Speaker ${names.size + 1}`);
		return names.get(id);
	};
	const turns = [];
	for (const w of words) {
		const last = turns.at(-1);
		if (w.type === 'word' && (!last || (w.speaker_id && w.speaker_id !== last.speaker))) {
			turns.push({ speaker: w.speaker_id, start: w.start, text: w.text });
		} else if (last) {
			last.text += w.text;
		}
	}
	return turns.map((t) => `[${clock(t.start)}] ${label(t.speaker)}: ${t.text.trim()}`).join('\n\n');
}

export async function transcribeWithElevenLabs(audioFile, { language, keyterms = [] } = {}) {
	const key = process.env.ELEVENLABS_API_KEY;
	if (!key) throw new Error('ELEVENLABS_API_KEY is not set on the server.');

	const form = new FormData();
	form.append('file', new Blob([await fs.readFile(audioFile)], { type: 'audio/ogg' }), path.basename(audioFile));
	form.append('model_id', process.env.ELEVENLABS_MODEL || 'scribe_v2');
	form.append('diarize', 'true');
	form.append('tag_audio_events', 'false');
	form.append('timestamps_granularity', 'word');
	if (language) form.append('language_code', language);
	for (const term of keyterms) form.append('keyterms', term);

	for (let attempt = 1; ; attempt++) {
		const res = await slowFetch(`${BASE}/v1/speech-to-text`, {
			method: 'POST',
			headers: { 'xi-api-key': key },
			body: form,
		});
		if (res.ok) return toTurns(await res.json());

		const body = await res.text();
		if ((res.status === 429 || res.status >= 500) && attempt < 4) {
			await new Promise((r) => setTimeout(r, attempt * 15_000));
			continue;
		}
		if (res.status === 401) throw new Error('ElevenLabs rejected the API key (401). Check ELEVENLABS_API_KEY.');
		if (res.status === 402) throw new Error('ElevenLabs: not enough credits on the account (402).');
		throw new Error(`ElevenLabs transcription failed (${res.status}): ${body.slice(0, 400)}`);
	}
}
