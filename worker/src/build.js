import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './exec.js';

const SITE_DIR = path.resolve(process.env.SITE_DIR || '../site');
const WWW_DIR = path.resolve(process.env.WWW_DIR || './www');

// Build the Astro site (it pulls published posts from Directus), copy it into a
// fresh release folder, then atomically repoint `current` so visitors never see
// a half-written site. Keeps the last three releases.
export async function buildSite() {
	const releases = path.join(WWW_DIR, 'releases');
	const name = new Date().toISOString().replace(/[:.]/g, '-');
	await fs.mkdir(releases, { recursive: true });

	const log = await run('npx', ['astro', 'build'], {
		cwd: SITE_DIR,
		env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
		timeoutMs: 5 * 60 * 1000,
	});
	await fs.cp(path.join(SITE_DIR, 'dist'), path.join(releases, name), { recursive: true });

	const tmpLink = path.join(WWW_DIR, 'current.tmp');
	await fs.rm(tmpLink, { force: true });
	await fs.symlink(path.join('releases', name), tmpLink);
	await fs.rename(tmpLink, path.join(WWW_DIR, 'current'));

	const old = (await fs.readdir(releases)).sort().slice(0, -3);
	await Promise.all(old.map((r) => fs.rm(path.join(releases, r), { recursive: true, force: true })));

	const posts = log.match(/(\d+) posts from/)?.[1];
	return { release: name, posts: posts ? Number(posts) : null };
}

export async function hasLiveSite() {
	return fs
		.stat(path.join(WWW_DIR, 'current', 'index.html'))
		.then(() => true)
		.catch(() => false);
}
