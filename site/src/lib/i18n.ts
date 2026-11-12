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
		skipToContent: 'رفتن به محتوای اصلی',
		eyebrow: 'یادداشت جلسه‌ها · فارسی و English',
		session: 'جلسه',
		inSession: 'در این جلسه',
		writtenBy: 'نوشتهٔ',
		theme: 'تغییر حالت روشن و تیره',
		contact: 'تماس',
		askUs: 'شما هم به همین مشکل خورده‌اید یا می‌خواهید بیشتر بدانید؟',
		emailUs: 'به ما ایمیل بزنید:',
		aiNote:
			'پیش‌نویس این یادداشت را یک مدل هوش مصنوعی از روی متن جلسه نوشته است. ما آن را خواندیم، ویرایش کردیم و بعد منتشرش کردیم.',
		translatedNote: 'جلسه به انگلیسی بود و این نسخهٔ فارسی را هوش مصنوعی ترجمه کرده است.',
		readOriginal: 'خواندن نسخهٔ اصلی',
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
		skipToContent: 'Skip to content',
		eyebrow: 'Session notes · English & فارسی',
		session: 'Session',
		inSession: 'In this session',
		writtenBy: 'Written by',
		theme: 'Switch between light and dark',
		contact: 'Contact',
		askUs: 'Ran into the same problem, or want to know more?',
		emailUs: 'Email us:',
		aiNote:
			'An AI model drafted this note from the session transcript. We read it, edited it and approved it before publishing.',
		translatedNote: 'The session was in Persian, and this English version was translated by AI.',
		readOriginal: 'Read the original',
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
