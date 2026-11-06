// Draws public/og.png, the picture shown when a link to the site is shared
// (X, LinkedIn, Telegram…). Run it again after changing the texts below:
//
//   cd site && node scripts/make-og-image.mjs
//
// It uses the fonts installed on your computer, so the result is committed
// and the server never runs this.
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const W = 1200;
const H = 630;
const colors = { bg: '#141416', surface: '#1c1c1f', text: '#ececee', muted: '#9a9aa2', accent: '#8aa6ff', border: '#2c2c31' };
const latin = "'Segoe UI', 'Helvetica Neue', Arial, sans-serif";
const persian = "Vazirmatn, Tahoma, 'Segoe UI', sans-serif";

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
	<rect width="${W}" height="${H}" fill="${colors.bg}"/>
	<rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="28" fill="${colors.surface}" stroke="${colors.border}" stroke-width="2"/>
	<rect x="96" y="120" width="72" height="8" rx="4" fill="${colors.accent}"/>
	<text x="96" y="250" font-family="${latin}" font-size="96" font-weight="800" fill="${colors.text}">Our Takeaway</text>
	<text x="${W - 96}" y="250" font-family="${persian}" font-size="64" font-weight="700" fill="${colors.muted}" text-anchor="end">برداشت ما</text>
	<text x="96" y="350" font-family="${latin}" font-size="38" fill="${colors.muted}">What we learn in our sessions, written down</text>
	<text x="96" y="400" font-family="${latin}" font-size="38" fill="${colors.muted}">in English and Persian.</text>
	<text x="96" y="530" font-family="${latin}" font-size="32" font-weight="700" fill="${colors.accent}">our-takeaway.blog</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL('../public/og.png', import.meta.url)));
console.log('wrote public/og.png');
