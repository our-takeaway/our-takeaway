import { getCollection, type CollectionEntry } from 'astro:content';
import type { Lang } from '../consts';
import { nameKey } from './names';

export type Person = {
	key: string;
	name: string;
	avatar?: string;
	bio: string;
	link?: string;
	initial: string; // for the placeholder
	tone: number; // placeholder colour, same 6 tones as the covers
};

const hash = (s: string) => {
	let h = 2166136261;
	for (const c of s) h = Math.imul(h ^ c.codePointAt(0)!, 16777619);
	return h >>> 0;
};
const initialOf = (name: string) => ([...name.trim()][0] || '?').toLocaleUpperCase();

function fromEntry(e: CollectionEntry<'people'>, lang: Lang): Person {
	const name = lang === 'fa' ? e.data.nameFa : e.data.name;
	return {
		key: e.id,
		name,
		avatar: e.data.avatar,
		bio: lang === 'fa' ? e.data.bioFa : e.data.bioEn,
		link: e.data.link,
		initial: initialOf(name),
		tone: hash(nameKey(e.data.name)) % 6,
	};
}

let cache: CollectionEntry<'people'>[] | null = null;
const allPeople = async () => (cache ??= await getCollection('people'));

/**
 * The people of a post, in order. Names come from the post (speakers or "People in this
 * session"); each is matched to the People collection by any spelling. Someone who isn't
 * there yet still shows, with a placeholder. No names: the authors (byAuthors = true).
 */
export async function peopleOf(names: string[], lang: Lang): Promise<{ people: Person[]; byAuthors: boolean }> {
	const all = await allPeople();
	if (!names.length) {
		const hosts = all.filter((e) => e.data.host).sort((a, b) => a.data.sort - b.data.sort);
		return { people: hosts.map((e) => fromEntry(e, lang)), byAuthors: true };
	}
	const people = names.map((n) => {
		const e = all.find((p) => p.data.keys.includes(nameKey(n)));
		return e ? fromEntry(e, lang) : { key: `n:${nameKey(n)}`, name: n, bio: '', initial: initialOf(n), tone: hash(nameKey(n)) % 6 };
	});
	return { people: people.filter((p, i) => people.findIndex((q) => q.key === p.key) === i), byAuthors: false };
}

export async function authors(lang: Lang) {
	return (await peopleOf([], lang)).people;
}

// "Sajad", "Sajad and Alireza", "Sajad, Alireza and Javad" (Persian: «سجاد، علیرضا و جواد»)
export function joinNames(names: string[], lang: Lang) {
	if (names.length < 2) return names[0] ?? '';
	const and = lang === 'fa' ? ' و ' : ' and ';
	const comma = lang === 'fa' ? '، ' : ', ';
	return `${names.slice(0, -1).join(comma)}${and}${names.at(-1)}`;
}
