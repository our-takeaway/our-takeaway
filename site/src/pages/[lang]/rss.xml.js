import rss from '@astrojs/rss';
import { SITE } from '../../consts';
import { langPaths } from '../../lib/i18n';
import { getPosts } from '../../lib/posts';

export const getStaticPaths = langPaths;

export async function GET(context) {
	const { lang } = context.params;
	const posts = await getPosts(lang);
	return rss({
		title: SITE[lang].title,
		description: SITE[lang].description,
		site: context.site,
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			pubDate: post.data.pubDate,
			categories: post.data.tags,
			link: `/${lang}/blog/${post.data.slug}/`,
		})),
	});
}
