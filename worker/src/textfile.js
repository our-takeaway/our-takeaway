import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.js';

// Read the text out of a transcript file: .txt .md .srt .vtt .docx .pdf

export const TEXT_EXTENSIONS = ['.txt', '.md', '.srt', '.vtt', '.docx', '.pdf'];

export const isTranscriptFile = (filename = '', type = '') =>
	TEXT_EXTENSIONS.includes(path.extname(filename).toLowerCase()) ||
	/^text\/|wordprocessingml|application\/pdf/.test(type);

function fromSubtitles(text) {
	return text
		.replace(/^﻿?WEBVTT[^\n]*\n/, '')
		.split(/\r?\n/)
		.filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^(NOTE|STYLE)\b/.test(l))
		.map((l) => l.replace(/<[^>]+>/g, '').trim())
		.join('\n');
}

function fromDocxXml(xml) {
	return xml
		.replace(/<w:tab\/>/g, '\t')
		.replace(/<w:br[^>]*\/>/g, '\n')
		.replace(/<\/w:p>/g, '\n')
		.replace(/<[^>]+>/g, '')
		.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export async function extractText(buffer, filename = 'transcript.txt', type = '') {
	const ext = path.extname(filename).toLowerCase();
	if (ext === '.docx' || type.includes('wordprocessingml')) {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docx-'));
		try {
			const file = path.join(dir, 'in.docx');
			await fs.writeFile(file, buffer);
			return fromDocxXml(await run('unzip', ['-p', file, 'word/document.xml']));
		} catch (e) {
			throw new Error(`Could not read the Word file "${filename}": ${e.message}`);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}
	if (ext === '.pdf' || type === 'application/pdf') {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-'));
		try {
			const file = path.join(dir, 'in.pdf');
			await fs.writeFile(file, buffer);
			return (await run('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'])).trim();
		} catch (e) {
			throw new Error(`Could not read the PDF "${filename}": ${e.message}`);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}
	const text = buffer.toString('utf8');
	if (ext === '.srt' || ext === '.vtt' || /-->/.test(text.slice(0, 2000))) return fromSubtitles(text);
	return text.trim();
}

// Rough language guess from the script: mostly Arabic-script letters → Persian.
export function detectLanguage(text) {
	const sample = String(text || '').slice(0, 20000);
	const persian = (sample.match(/[؀-ۿ]/g) || []).length;
	const latin = (sample.match(/[A-Za-z]/g) || []).length;
	return persian > latin * 0.5 ? 'fa' : 'en';
}
