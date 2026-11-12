import { directus } from './directus.js';

// The People collection: who appears on posts (photo, names, short bios).
// Names are compared the same way as on the site (site/src/lib/names.ts).

export function nameKey(name) {
	return String(name ?? '')
		.normalize('NFC')
		.toLowerCase()
		.replace(/ي/g, 'ی')
		.replace(/ك/g, 'ک')
		.replace(/[‌‍\s.\-_'’"«»]/g, '');
}
const firstWord = (s) => String(s ?? '').trim().split(/\s+/)[0] || '';

export const listPeople = () => directus('GET', '/items/people?limit=-1&sort=sort,id');
export const getPerson = (id) => directus('GET', `/items/people/${encodeURIComponent(id)}`);
export const updatePerson = (id, data) => directus('PATCH', `/items/people/${encodeURIComponent(id)}`, data);
export const createPerson = (data) => directus('POST', '/items/people', data);
export const deletePerson = (id) => directus('DELETE', `/items/people/${encodeURIComponent(id)}`);

const keysOf = (p) =>
	[p.short_name, p.name, p.name_fa, firstWord(p.name), firstWord(p.name_fa), ...(Array.isArray(p.aliases) ? p.aliases : [])]
		.filter(Boolean)
		.map(nameKey);

export const findPerson = (people, name) => people.find((p) => keysOf(p).includes(nameKey(name)));

/** Add anyone named as a speaker who isn't in People yet. Returns the names that were added. */
export async function ensurePeople(names = []) {
	const wanted = [...new Set(names.map((n) => String(n).trim()).filter(Boolean))];
	if (!wanted.length) return [];
	let people;
	try {
		people = await listPeople();
	} catch (e) {
		console.error('people:', e.message); // e.g. the collection isn't set up yet
		return [];
	}
	const added = [];
	for (const name of wanted) {
		if (findPerson(people, name)) continue;
		const person = await createPerson({ name, short_name: name, sort: people.length + added.length + 1 });
		people.push(person);
		added.push(name);
	}
	return added;
}
