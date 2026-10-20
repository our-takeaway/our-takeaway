// @ts-check
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';

// SITE_URL is set by docker-compose (e.g. https://blog.example.com)
export default defineConfig({
	site: process.env.SITE_URL || 'http://localhost:4321',
	integrations: [sitemap()],
	markdown: {
		shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' } },
	},
	fonts: [
		{
			provider: fontProviders.google(),
			name: 'Vazirmatn',
			cssVariable: '--font-vazir',
			weights: [400, 700, 800],
			subsets: ['arabic', 'latin'],
			fallbacks: ['system-ui', 'sans-serif'],
		},
	],
});
