// Site texts in both languages — edit freely.

export const LANGS = ['fa', 'en'] as const;
export type Lang = (typeof LANGS)[number];

export const SITE = {
	fa: {
		title: 'برداشت ما',
		description: 'آنچه در جلسه‌هایمان یاد می‌گیریم، برای این‌که پیشرفتمان را دنبال کنیم.',
		intro: [
			'این‌جا قرار نیست به کسی چیزی یاد بدهیم. فقط چیزهایی را که در جلسه‌هایمان یاد می‌گیریم ثبت می‌کنیم.',
			'منتشرش می‌کنیم تا پیشرفت خودمان را دنبال کنیم، و شاید روزی کسی که به همان مشکلی خورده که ما خوردیم، این‌جا چیزی به کارش بیاید.',
		],
		authors: ['سجاد سرلکی', 'علیرضا اسدی'],
	},
	en: {
		title: 'Our Takeaway',
		description: 'What we learn in our sessions, written down to keep track of our progress.',
		intro: [
			'This is not a place where we teach. We just write down what we learned in our sessions.',
			'We share it to track our progress, and in case someone runs into the same problem we did and wants to know more.',
		],
		authors: ['Sajad Sarlaki', 'Alireza Asadi'],
	},
} satisfies Record<Lang, unknown>;

export const LINKS: { label: string; href: string }[] = [
	// { label: 'X', href: 'https://x.com/your-handle' },
	// { label: 'Reddit', href: 'https://reddit.com/u/your-handle' },
];
