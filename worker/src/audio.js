import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './exec.js';

// Keep only the voice: mono, 16 kHz, Opus. An hour of meeting video (often 1 GB+)
// becomes ~15 MB, which uploads to the speech-to-text API in seconds.
export async function extractAudio(input, output) {
	try {
		await run('ffmpeg', [
			'-hide_banner', '-loglevel', 'error', '-y',
			'-i', input,
			'-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k',
			output,
		], { timeoutMs: 30 * 60_000 });
	} catch (e) {
		const reason = e.message.split(': ').at(-1).slice(0, 120);
		throw new Error(`Could not read audio from this file. Is it an audio or video file? (ffmpeg: ${reason})`);
	}
	const { size } = await fs.stat(output);
	if (size < 2000) throw new Error('This file has no audible sound track.');
	return output;
}

// Whisper-style APIs accept ~25 MB per request, so they get 20-minute pieces.
export async function splitAudio(input, dir, seconds = 1200) {
	await run('ffmpeg', [
		'-hide_banner', '-loglevel', 'error', '-y',
		'-i', input,
		'-c', 'copy', '-f', 'segment', '-segment_time', String(seconds), '-reset_timestamps', '1',
		path.join(dir, 'part%03d.ogg'),
	], { timeoutMs: 10 * 60_000 });
	return (await fs.readdir(dir)).filter((f) => f.startsWith('part')).sort().map((f) => path.join(dir, f));
}
