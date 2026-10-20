import { getCollection, type CollectionEntry } from 'astro:content';
import type { Lang } from '../consts';

export type Post = CollectionEntry<'posts'>;

export async function getPosts(lang: Lang): Promise<Post[]> {
	const posts = await getCollection('posts', ({ data }) => data.lang === lang);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}
