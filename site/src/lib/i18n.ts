import { LANGS, type Lang } from '../consts';

const strings = {
	fa: {
		home: 'خانه',
		allPosts: 'همهٔ پست‌ها',
		about: 'دربارهٔ ما',
		latest: 'تازه‌ترین جلسه‌ها',
		seeAll: 'همه ←',
		noPosts: 'هنوز پستی منتشر نشده.',
		meeting: 'جلسهٔ',
		minRead: 'دقیقه مطالعه',
		updated: 'به‌روزرسانی:',
		prev: 'قبلی',
		next: 'بعدی',
		howItWorks: 'چطور کار می‌کند؟',
		howItWorksText:
			'جلسه‌ها پیاده می‌شوند و یک مدل هوش مصنوعی از روی متن، پیش‌نویس یادداشت را به دو زبان می‌نویسد. ما پیش‌نویس را می‌خوانیم و اصلاح می‌کنیم و فقط بعد از تأیید ما منتشر می‌شود.',
		authors: 'نویسنده‌ها',
		notFound: 'این صفحه پیدا نشد',
		backHome: 'برگردید به صفحهٔ اول',
		switchTo: 'English',
	},
	en: {
		home: 'Home',
		allPosts: 'All posts',
		about: 'About',
		latest: 'Latest sessions',
		seeAll: 'All →',
		noPosts: 'Nothing published yet.',
		meeting: 'Session',
		minRead: 'min read',
		updated: 'Updated:',
		prev: 'Previous',
		next: 'Next',
		howItWorks: 'How it works',
		howItWorksText:
			'Sessions are transcribed, and an AI model drafts the notes in both languages. We read and edit the draft, and nothing is published until we approve it.',
		authors: 'Authors',
		notFound: 'Page not found',
		backHome: 'Back to the home page',
		switchTo: 'فارسی',
	},
} satisfies Record<Lang, Record<string, string>>;

export type Key = keyof (typeof strings)['fa'];

export const t = (lang: Lang, key: Key) => strings[lang][key];
export const dirOf = (lang: Lang) => (lang === 'fa' ? 'rtl' : 'ltr');
export const otherLang = (lang: Lang): Lang => (lang === 'fa' ? 'en' : 'fa');
export const langPaths = () => LANGS.map((lang) => ({ params: { lang } }));

export function formatDate(date: Date, lang: Lang) {
	return date.toLocaleDateString(lang === 'fa' ? 'fa-IR' : 'en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function digits(n: number | string, lang: Lang) {
	const s = String(n);
	return lang === 'fa' ? s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]) : s;
}

export function readingMinutes(text: string | undefined) {
	return Math.max(1, Math.round((text ?? '').split(/\s+/).filter(Boolean).length / 200));
}
