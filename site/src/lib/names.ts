// One way to compare names however they are written: case, spaces, half-spaces and the
// Arabic forms of ی / ک don't matter. "Sajad", "sajad", "سجاد" each become one key.
export function nameKey(name: unknown) {
	return String(name ?? '')
		.normalize('NFC')
		.toLowerCase()
		.replace(/ي/g, 'ی')
		.replace(/ك/g, 'ک')
		.replace(/[‌‍\s.\-_'’"«»]/g, '');
}

export const firstWord = (s: unknown) => String(s ?? '').trim().split(/\s+/)[0] || '';

// "Speaker 1 = Sajad\nSpeaker 2 = Javad" → ['Sajad', 'Javad'] (in speaker order, no repeats)
export function speakersOf(notes: unknown) {
	const found = [...String(notes ?? '').matchAll(/speaker\s*(\d+)\s*[=:]\s*([^\n,،;]+)/gi)]
		.map((m) => ({ n: Number(m[1]), name: m[2].trim() }))
		.filter((s) => s.name)
		.sort((a, b) => a.n - b.n);
	const seen = new Set<string>();
	return found.map((s) => s.name).filter((n) => !seen.has(nameKey(n)) && seen.add(nameKey(n)));
}
