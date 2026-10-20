import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { directusLoader } from './lib/directus-loader';

const posts = defineCollection({
	loader: directusLoader(),
	schema: z.object({
		lang: z.enum(['fa', 'en']),
		slug: z.string(),
		title: z.string(),
		description: z.string(),
		tags: z.array(z.string()).default([]),
		meeting: z.number().int().optional(),
		pubDate: z.coerce.date(),
		updatedDate: z.coerce.date().optional(),
		langs: z.array(z.enum(['fa', 'en'])),
	}),
});

export const collections = { posts };
