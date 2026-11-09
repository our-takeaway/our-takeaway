// Draws public/og.png, the picture shown when a link to the site is shared
// (X, LinkedIn, Telegram…). Run it again after changing the texts below:
//
//   cd site && node scripts/make-og-image.mjs
//
// It uses the fonts installed on your computer, so the result is committed
// and the server never runs this. Colours match src/styles/global.css.
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const W = 1200;
const H = 630;
const c = { bg: '#f6f2ea', card: '#fcfaf5', text: '#1f1b16', muted: '#6e6558', accent: '#0f6b62', border: '#e2d9c9', gold: '#e8bf73', note: '#8d5a0c' };
const serif = "Newsreader, Georgia, 'Times New Roman', serif";
const sans = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const persian = "Vazirmatn, Tahoma, 'Segoe UI', sans-serif";

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
	<rect width="${W}" height="${H}" fill="${c.bg}"/>
	<rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="28" fill="${c.card}" stroke="${c.border}" stroke-width="2"/>
	<g transform="translate(96 104) scale(2.4)">
		<rect width="32" height="32" rx="9" fill="${c.accent}"/>
		<path d="M9 11h14M9 16h14M9 21h8" stroke="${c.bg}" stroke-width="2.6" stroke-linecap="round"/>
		<circle cx="23" cy="21" r="2.6" fill="${c.gold}"/>
	</g>
	<text x="${W - 96}" y="160" font-family="${persian}" font-size="44" font-weight="700" fill="${c.muted}" text-anchor="end">برداشت ما</text>
	<text x="92" y="320" font-family="${serif}" font-size="112" font-weight="600" fill="${c.text}">Our Takeaway</text>
	<text x="96" y="390" font-family="${serif}" font-size="38" fill="${c.muted}">What we learn in our sessions, written down</text>
	<text x="96" y="438" font-family="${serif}" font-size="38" fill="${c.muted}">in English and Persian.</text>
	<rect x="96" y="500" width="64" height="4" rx="2" fill="${c.accent}"/>
	<text x="96" y="550" font-family="${sans}" font-size="28" font-weight="700" fill="${c.accent}" letter-spacing="1">our-takeaway.blog</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL('../public/og.png', import.meta.url)));
console.log('wrote public/og.png');
