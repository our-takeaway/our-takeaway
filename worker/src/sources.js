import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { slowFetch } from './http.js';

// Where a recording can come from:
//   - a file uploaded to Directus (fileId)
//   - a Google Drive link shared as "Anyone with the link"
//   - any other direct https link to an audio/video file

const MAX_BYTES = 5 * 1024 ** 3; // 5 GB

export function googleDriveId(url) {
	let u;
	try {
		u = new URL(url);
	} catch {
		return null;
	}
	if (!/(^|\.)(drive|docs)\.google\.com$|^drive\.usercontent\.google\.com$/.test(u.hostname)) return null;
	return u.pathname.match(/\/file\/d\/([\w-]{10,})/)?.[1] ?? u.searchParams.get('id');
}

function downloadUrlFor(url) {
	if (/\/drive\/(u\/\d+\/)?folders\//.test(url)) {
		throw new Error('That is a Google Drive folder link. Open the file itself and copy its link.');
	}
	const driveId = googleDriveId(url);
	if (driveId) {
		// confirm=t skips Drive's "can't scan this large file for viruses" page.
		return { url: `https://drive.usercontent.google.com/download?id=${driveId}&export=download&confirm=t`, drive: true };
	}
	if (/(^|\.)google\.com$/.test(new URL(url).hostname)) {
		throw new Error('This Google link is not a Drive file link. Use "Share → Copy link" on the file in Google Drive.');
	}
	return { url, drive: false };
}

async function save(res, dest, what) {
	const type = res.headers.get('content-type') || '';
	if (type.startsWith('text/html')) {
		throw new Error(
			what === 'drive'
				? 'Google Drive returned a web page instead of the file. Set the file\'s sharing to "Anyone with the link" and try again.'
				: 'The link returned a web page, not an audio or video file. Use a direct link to the file.',
		);
	}
	const size = Number(res.headers.get('content-length') || 0);
	if (size > MAX_BYTES) throw new Error(`The file is ${(size / 1024 ** 3).toFixed(1)} GB; the limit is 5 GB.`);
	await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

export async function downloadSource({ fileId, url }, dest) {
	if (fileId) {
		if (!/^[\w-]+$/.test(fileId)) throw new Error('bad file id');
		const res = await slowFetch(`${process.env.DIRECTUS_URL.replace(/\/$/, '')}/assets/${fileId}`, {
			headers: { Authorization: `Bearer ${process.env.DIRECTUS_TOKEN}` },
		});
		if (!res.ok) throw new Error(`Could not read the uploaded file from Directus (${res.status}).`);
		return save(res, dest, 'directus');
	}
	if (!url || !/^https?:\/\//i.test(url.trim())) throw new Error('The recording link must start with https://');
	const target = downloadUrlFor(url.trim());
	const res = await slowFetch(target.url, { redirect: 'follow' });
	if (!res.ok) {
		throw new Error(
			target.drive
				? `Google Drive refused the download (${res.status}). Check that the file is shared as "Anyone with the link".`
				: `Could not download the recording (${res.status}).`,
		);
	}
	return save(res, dest, target.drive ? 'drive' : 'url');
}
