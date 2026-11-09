// Napkin AI (https://api.napkin.ai): short text in, a diagram out.
//   POST /v1/visual → poll GET /v1/visual/{id}/status → download generated_files[0].url
// File links expire after 30 minutes, so the image is downloaded right away.
//
// Keys: NAPKIN_API_KEY_1, NAPKIN_API_KEY_2, NAPKIN_API_KEY_3 (or NAPKIN_API_KEYS=a,b,c).
// The first one is tried first; when a key can't do the job (no credits, revoked, limit
// reached, Napkin down…) the next one is tried. A problem with the text itself fails at once,
// since another key wouldn't change it.

const BASE = () => (process.env.NAPKIN_API_BASE || 'https://api.napkin.ai').replace(/\/$/, '');

export function napkinKeys() {
	const listed = (process.env.NAPKIN_API_KEYS || '').split(',');
	const numbered = [1, 2, 3, 4, 5].map((n) => process.env[`NAPKIN_API_KEY_${n}`]);
	return [...new Set([...numbered, ...listed].map((k) => (k || '').trim()).filter(Boolean))];
}

// Codes that are about the key or Napkin itself: worth trying the next key.
const NEXT_KEY = new Set(['token_expired', 'token_revoked', 'missing_authorization', 'invalid_token', 'insufficient_scope', 'forbidden',
	'no_credits', 'generation_limit_exceeded', 'rate_limit_exceeded', 'too_many_failed_attempts', 'internal_error', 'service_unavailable']);

class NapkinError extends Error {
	constructor(message, { code, status, nextKey } = {}) {
		super(message);
		this.code = code;
		this.status = status;
		this.nextKey = nextKey ?? (NEXT_KEY.has(code) || status === 401 || status === 402 || status === 403 || status === 429 || status >= 500);
	}
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(key, method, path, body) {
	let res;
	try {
		res = await fetch(path.startsWith('http') ? path : BASE() + path, {
			method,
			headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(60_000),
		});
	} catch (e) {
		throw new NapkinError(`Napkin could not be reached: ${e.message}`, { nextKey: true });
	}
	if (res.ok) return res;
	const json = await res.json().catch(() => ({}));
	const err = new NapkinError(`${json.error || res.status}: ${json.message || res.statusText}`, { code: json.error, status: res.status });
	err.retryAfter = Number(res.headers.get('retry-after')) || 0;
	throw err;
}

// One visual with one key. Resolves { buffer, width, height, visualId, requestId }.
async function generateWith(key, request) {
	let created;
	try {
		created = await (await call(key, 'POST', '/v1/visual', request)).json();
	} catch (e) {
		// a short rate-limit pause is worth waiting for on the same key
		if (e.code === 'rate_limit_exceeded' && e.retryAfter && e.retryAfter <= 15) {
			await wait(e.retryAfter * 1000);
			created = await (await call(key, 'POST', '/v1/visual', request)).json();
		} else throw e;
	}

	let status = created;
	const deadline = Date.now() + 4 * 60_000;
	for (let delay = 2000; status.status === 'pending'; delay = Math.min(delay * 1.5, 8000)) {
		if (Date.now() > deadline) throw new NapkinError('Napkin took more than 4 minutes to draw the diagram.', { nextKey: false });
		await wait(delay);
		status = await (await call(key, 'GET', `/v1/visual/${created.id}/status`)).json();
	}
	if (status.status !== 'completed') {
		const code = status.error?.error || status.error?.code;
		throw new NapkinError(`Napkin could not draw it: ${code || 'failed'}${status.error?.message ? ` (${status.error.message})` : ''}`, { code });
	}
	const file = status.generated_files?.[0];
	if (!file?.url) throw new NapkinError('Napkin finished but sent no file.', { nextKey: false });
	const buffer = Buffer.from(await (await call(key, 'GET', file.url)).arrayBuffer());
	return { buffer, width: file.width, height: file.height, visualId: file.visual_id, requestId: created.id };
}

// After a fallback, the key that worked goes first for the next hour, so a key with no
// credits isn't asked again for every picture.
let preferred = { key: null, until: 0 };

/** Draw one visual, trying each key in turn. */
export async function generateVisual(request) {
	const all = napkinKeys();
	if (!all.length) throw new Error('No Napkin API key. Add NAPKIN_API_KEY_1 (and, as backups, NAPKIN_API_KEY_2 and NAPKIN_API_KEY_3) to .env.');
	const first = Date.now() < preferred.until && all.includes(preferred.key) ? preferred.key : null;
	const keys = first ? [first, ...all.filter((k) => k !== first)] : all;
	const failures = [];
	for (const key of keys) {
		const n = all.indexOf(key) + 1;
		try {
			const out = await generateWith(key, request);
			if (failures.length) console.log(`napkin: key ${n} worked after ${failures.join('; ')}`);
			preferred = n > 1 ? { key, until: Date.now() + 60 * 60_000 } : { key: null, until: 0 };
			return { ...out, key: n };
		} catch (e) {
			failures.push(`key ${n}: ${e.message}`);
			console.error(`napkin key ${n}:`, e.message);
			if (!e.nextKey) break;
		}
	}
	throw new Error(failures.length > 1 ? `Every Napkin key failed:\n${failures.join('\n')}` : `Napkin: ${failures[0].replace(/^key \d+: /, '')}`);
}
