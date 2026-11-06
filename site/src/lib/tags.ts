// Tags come from the AI, so one tag can arrive in several spellings
// ("VR" / "vr", "Interaction Design" / "interaction design"). All spellings share
// one URL slug, and every post shows the same spelling for it.

const clean = (tag: unknown) =>
	String(tag ?? '')
		.normalize('NFC')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^#+/, '');

// "Bob's Books" → "bobs-books", "واقعیت مجازی" → "واقعیت-مجازی"
export function tagSlug(tag: string) {
	return clean(tag)
		.toLowerCase()
		.replace(/['’`"]/g, '')
		.replace(/[\s_/\\?#%&]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

const capitals = (s: string) => (s.match(/\p{Lu}/gu) ?? []).length;

/**
 * Picks one spelling per tag across all posts of a language: the one with more
 * capitals (so acronyms and names keep theirs: "VR", "Claude"), then the most used.
 * Returns a function that turns a post's tags into those spellings, without duplicates.
 */
export function tagNormalizer(tagLists: unknown[][]) {
	const forms = new Map<string, Map<string, number>>();
	for (const list of tagLists) {
		for (const raw of list ?? []) {
			const label = clean(raw);
			const slug = tagSlug(label);
			if (!slug) continue;
			const counts = forms.get(slug) ?? new Map<string, number>();
			counts.set(label, (counts.get(label) ?? 0) + 1);
			forms.set(slug, counts);
		}
	}
	const best = new Map<string, string>();
	for (const [slug, counts] of forms) {
		const [label] = [...counts].sort((a, b) => capitals(b[0]) - capitals(a[0]) || b[1] - a[1])[0];
		best.set(slug, label);
	}
	return (tags: unknown[] = []) => [
		...new Set(
			tags
				.map(clean)
				.filter((tag) => tagSlug(tag))
				.map((tag) => best.get(tagSlug(tag)) ?? tag),
		),
	];
}
