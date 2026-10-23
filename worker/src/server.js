import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { buildSite, hasLiveSite } from './build.js';
import { transcribe } from './transcribe.js';

// The worker does the two jobs n8n can't do on its own:
//   POST /build       rebuild the static site from Directus          → { release, posts }
//   POST /transcribe  { fileId | url, provider, language, keyterms } → { text }
//                     recording (upload, Google Drive link, URL) → voice only → ElevenLabs or Whisper
// Both require "Authorization: Bearer $WORKER_SECRET". Only reachable inside Docker.

const PORT = Number(process.env.PORT || 4000);
const SECRET = process.env.WORKER_SECRET || '';
if (!SECRET) {
	console.error('WORKER_SECRET is not set');
	process.exit(1);
}

// One build at a time; a request that arrives mid-build waits for the next one.
let building = Promise.resolve();
const queueBuild = () => (building = building.catch(() => {}).then(buildSite));

function authorized(req) {
	const given = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
	const want = Buffer.from(SECRET);
	return given.length === want.length && timingSafeEqual(given, want);
}

async function readJson(req) {
	let body = '';
	for await (const chunk of req) body += chunk;
	return body ? JSON.parse(body) : {};
}

function send(res, status, data) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(data));
}

const routes = {
	'POST /build': async () => queueBuild(),
	'POST /transcribe': async (req) => ({ text: await transcribe(await readJson(req)) }),
};

http
	.createServer(async (req, res) => {
		if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
		const route = routes[`${req.method} ${req.url}`];
		if (!route) return send(res, 404, { error: 'not found' });
		if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
		const started = Date.now();
		try {
			const result = await route(req);
			console.log(`${req.method} ${req.url} ok in ${Date.now() - started}ms`);
			send(res, 200, result);
		} catch (e) {
			console.error(`${req.method} ${req.url} failed:`, e.message);
			send(res, e.status || 500, { error: e.message });
		}
	})
	.listen(PORT, async () => {
		console.log(`worker on :${PORT}`);
		// On a fresh server Directus may not have its tables yet, so keep trying for a while.
		for (let attempt = 1; attempt <= 20 && !(await hasLiveSite()); attempt++) {
			console.log(`no built site yet — building (attempt ${attempt})…`);
			try {
				await queueBuild();
			} catch (e) {
				console.error('initial build failed:', e.message.slice(0, 300));
				await new Promise((r) => setTimeout(r, 30_000));
			}
		}
	});
