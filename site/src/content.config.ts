import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { directusLoader, peopleLoader } from './lib/directus-loader';

const posts = defineCollection({
	loader: directusLoader(),
	schema: z.object({
		lang: z.enum(['fa', 'en']),
		slug: z.string(),
		title: z.string(),
		description: z.string(),
		tags: z.array(z.string()).default([]),
		meeting: z.number().int().optional(),
		sourceLang: z.enum(['fa', 'en']).optional(),
		pubDate: z.coerce.date(),
		updatedDate: z.coerce.date().optional(),
		langs: z.array(z.enum(['fa', 'en'])),
		// names of the people in the session (People collection), in order; empty = the authors
		people: z.array(z.string()).default([]),
	}),
});

// People shown on posts (Directus "people"): authors and anyone named as a speaker.
const people = defineCollection({
	loader: peopleLoader(),
	schema: z.object({
		name: z.string(),
		nameFa: z.string(),
		keys: z.array(z.string()), // every way the name is written, lowercased
		avatar: z.string().optional(),
		bioEn: z.string().default(''),
		bioFa: z.string().default(''),
		link: z.string().optional(),
		host: z.boolean().default(false),
		sort: z.number().default(0),
	}),
});

export const collections = { posts, people };
