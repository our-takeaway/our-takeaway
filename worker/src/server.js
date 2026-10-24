import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { handleUpdate } from './bot.js';
import { buildSite, hasLiveSite } from './build.js';
import { reportStage } from './stages.js';
import * as tg from './telegram.js';
import { transcribePost } from './transcribe.js';

// The worker does what n8n can't do well on its own. Called by n8n (Bearer WORKER_SECRET):
//   POST /build       rebuild the static site from Directus             → { release, posts }
//   POST /transcribe  { postId }  file / recording / link → transcript  → { text, language, model, seconds, chars }
//   POST /stage       { postId, stage, state, info?, error? }  progress log + status + Telegram
// Called by Telegram (secret header, through Caddy at https://<CMS_DOMAIN>/telegram/webhook):
//   POST /telegram/webhook

const PORT = Number(process.env.PORT || 4000);
const SECRET = process.env.WORKER_SECRET || '';
if (!SECRET) {
	console.error('WORKER_SECRET is not set');
	process.exit(1);
}
// Telegram sends this back in a header so we know the request really came from it.
const TELEGRAM_SECRET = createHash('sha256').update(`telegram:${SECRET}`).digest('hex').slice(0, 64);

// One build at a time; a request that arrives mid-build waits for the next one.
let building = Promise.resolve();
const queueBuild = () => (building = building.catch(() => {}).then(buildSite));

const same = (a, b) => {
	const x = Buffer.from(a || '');
	const y = Buffer.from(b || '');
	return x.length === y.length && timingSafeEqual(x, y);
};

async function readJson(req) {
	let body = '';
	for await (const chunk of req) body += chunk;
	return body ? JSON.parse(body) : {};
}

function send(res, status, data) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(data));
}

const need = (obj, key) => {
	if (obj[key] === undefined || obj[key] === null || obj[key] === '') throw Object.assign(new Error(`${key} is required`), { status: 400 });
	return obj[key];
};

const routes = {
	'POST /build': async () => queueBuild(),
	'POST /transcribe': async (req) => transcribePost(need(await readJson(req), 'postId')),
	'POST /stage': async (req) => {
		const body = await readJson(req);
		need(body, 'postId');
		return reportStage(body);
	},
};

http
	.createServer(async (req, res) => {
		if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });

		if (req.method === 'POST' && req.url === '/telegram/webhook') {
			if (!same(req.headers['x-telegram-bot-api-secret-token'], TELEGRAM_SECRET)) return send(res, 401, { error: 'unauthorized' });
			const update = await readJson(req).catch(() => ({}));
			send(res, 200, { ok: true }); // answer Telegram right away; work continues below
			return handleUpdate(update);
		}

		const route = routes[`${req.method} ${req.url}`];
		if (!route) return send(res, 404, { error: 'not found' });
		if (!same((req.headers.authorization || '').replace(/^Bearer /, ''), SECRET)) return send(res, 401, { error: 'unauthorized' });
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

		if (tg.enabled() && process.env.TELEGRAM_WEBHOOK_URL) {
			tg.setWebhook(process.env.TELEGRAM_WEBHOOK_URL, TELEGRAM_SECRET)
				.then(() => console.log(`telegram webhook → ${process.env.TELEGRAM_WEBHOOK_URL}`))
				.catch((e) => console.error('telegram webhook setup failed:', e.message));
		}

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
