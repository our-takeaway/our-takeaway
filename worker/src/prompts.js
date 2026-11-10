import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The default prompts live in directus/prompts/ (copied into the worker image as /app/prompts).
// Writer Settings keeps the ones in use; these files are the defaults to start from or go back to.

const DIR = process.env.PROMPTS_DIR || fileURLToPath(new URL('../../directus/prompts/', import.meta.url));

// Writer Settings field → default file
export const PROMPTS = {
	system_prompt: { file: 'writer.md', name: 'Writing prompt', download: 'writing-prompt.md' },
	translation_prompt: { file: 'translator.md', name: 'Translation prompt', download: 'translation-prompt.md' },
	diagram_prompt: { file: 'diagram.md', name: 'Diagram prompt', download: 'diagram-prompt.md' },
};

export const defaultPrompt = (field) => fs.readFileSync(path.join(DIR, PROMPTS[field].file), 'utf8');

// {{name}} → value; unknown placeholders stay as they are.
export const fill = (text, vars) => String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

// The placeholders the diagram prompt can use (filled in for every diagram).
export const DIAGRAM_PLACEHOLDERS = {
	min: 'fewest words per language',
	max: 'most words per language',
	target: 'the length to aim for',
	languages: 'the languages of the post',
	layouts: 'the kinds of diagram Napkin is asked for',
};
