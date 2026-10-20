// Creates everything the blog needs inside Directus. Safe to run again: it only
// adds what is missing and never deletes or overwrites your content.
//
//   posts            one row per meeting → post (both languages + social texts)
//   writer_settings  the AI prompt, model and social settings, editable in the panel
//   flow             "Send post events to n8n": every create/update on posts is POSTed to n8n
//
// Usage: DIRECTUS_URL=… DIRECTUS_TOKEN=… N8N_WEBHOOK_URL=… N8N_WEBHOOK_SECRET=… node setup.mjs

import fs from 'node:fs/promises';

const URL_ = (process.env.DIRECTUS_URL || 'http://localhost:8055').replace(/\/$/, '');
const TOKEN = process.env.DIRECTUS_TOKEN;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/directus-posts';
const N8N_WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET;
if (!TOKEN || !N8N_WEBHOOK_SECRET) throw new Error('DIRECTUS_TOKEN and N8N_WEBHOOK_SECRET are required');

async function api(method, path, body) {
	const res = await fetch(URL_ + path, {
		method,
		headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
	return text ? JSON.parse(text).data : null;
}

async function waitForDirectus() {
	for (let i = 0; i < 60; i++) {
		try {
			if ((await fetch(`${URL_}/server/ping`)).ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 2000));
	}
	throw new Error('Directus did not become healthy');
}

// ---------- field helpers (keep the schema below readable) ----------

let sort = 0;
const group = (field, name, { open = true, groupOf } = {}) => ({
	field,
	type: 'alias',
	meta: {
		special: ['alias', 'no-data', 'group'],
		interface: 'group-detail',
		options: { start: open ? 'open' : 'closed' },
		translations: [{ language: 'en-US', translation: name }],
		group: groupOf ?? null,
		sort: ++sort,
		width: 'full',
	},
});

const field = (name, type, meta = {}, schema = {}) => ({
	field: name,
	type,
	meta: { sort: ++sort, width: 'full', ...meta },
	schema,
});

const choices = (list) => list.map(([value, text, color]) => ({ value, text, color }));

// ---------- the posts collection ----------

const STATUS = choices([
	['new', 'New — waiting for AI', '#A2B5CD'],
	['processing', 'AI is working…', '#3399FF'],
	['review', 'Ready for review', '#FFA439'],
	['revise', 'Revise with AI (uses Feedback)', '#9B51E0'],
	['approved', 'Approved — publish now', '#2ECDA7'],
	['publishing', 'Publishing…', '#3399FF'],
	['published', 'Published', '#00C897'],
	['archived', 'Removed from site', '#737373'],
	['error', 'Error — see message', '#E35169'],
]);

const postFields = [
	field('status', 'string', {
		interface: 'select-dropdown',
		display: 'labels',
		options: { choices: STATUS },
		display_options: { showAsDot: false, choices: STATUS },
		note: 'Change this to move the post along: Approved publishes it, Revise rewrites it with your feedback, Removed takes it off the site.',
		width: 'half',
		required: true,
	}, { default_value: 'new', is_nullable: false }),
	field('slug', 'string', { interface: 'input', note: 'Part of the post URL, e.g. /fa/blog/rag-basics/ — the AI suggests one.', width: 'half', options: { slug: true } }, { is_unique: true }),
	field('error_message', 'text', { interface: 'input-multiline', readonly: true, hidden: false, note: 'Filled in by the automation when something fails.', conditions: [{ name: 'hide when empty', rule: { error_message: { _null: true } }, hidden: true }] }),

	group('input_group', '1 · Meeting (input)'),
	field('title', 'string', { interface: 'input', group: 'input_group', width: 'half', note: 'Working title (optional)' }),
	field('meeting_number', 'integer', { interface: 'input', group: 'input_group', width: 'half' }),
	field('transcript', 'text', { interface: 'input-multiline', group: 'input_group', note: 'Paste the transcript here (from Meet, Zoom, or a free local tool). Saving a new post starts the AI.' }),
	field('notes', 'text', { interface: 'input-multiline', group: 'input_group', note: 'Optional notes for the AI: what to focus on, correct spelling of names and terms, what to leave out.' }),
	field('audio', 'uuid', { interface: 'file', special: ['file'], group: 'input_group', width: 'half', note: 'Optional: recording, only used if the box on the right is ticked and there is no transcript.' }),
	field('transcribe_audio', 'boolean', { interface: 'boolean', special: ['cast-boolean'], group: 'input_group', width: 'half', options: { label: 'Transcribe the audio with Whisper (paid)' } }, { default_value: false }),
	field('feedback', 'text', { interface: 'input-multiline', group: 'input_group', note: 'What should the AI change? Write it here, then set status to "Revise with AI".' }),

	group('fa_group', '2 · فارسی'),
	field('title_fa', 'string', { interface: 'input', group: 'fa_group', options: { font: 'sans-serif' } }),
	field('description_fa', 'text', { interface: 'input-multiline', group: 'fa_group' }),
	field('tags_fa', 'json', { interface: 'tags', special: ['cast-json'], group: 'fa_group' }),
	field('body_fa', 'text', { interface: 'input-rich-text-md', group: 'fa_group' }),

	group('en_group', '3 · English'),
	field('title_en', 'string', { interface: 'input', group: 'en_group' }),
	field('description_en', 'text', { interface: 'input-multiline', group: 'en_group' }),
	field('tags_en', 'json', { interface: 'tags', special: ['cast-json'], group: 'en_group' }),
	field('body_en', 'text', { interface: 'input-rich-text-md', group: 'en_group' }),

	group('social_group', '4 · X and Reddit'),
	field('share_x', 'boolean', { interface: 'boolean', special: ['cast-boolean'], group: 'social_group', width: 'half', options: { label: 'Post on X when published' } }, { default_value: true }),
	field('share_reddit', 'boolean', { interface: 'boolean', special: ['cast-boolean'], group: 'social_group', width: 'half', options: { label: 'Post on Reddit when published' } }, { default_value: true }),
	field('tweet', 'text', { interface: 'input-multiline', group: 'social_group', note: 'The link is added automatically.' }),
	field('reddit_title', 'string', { interface: 'input', group: 'social_group' }),
	field('reddit_body', 'text', { interface: 'input-multiline', group: 'social_group', note: 'Used for text posts; link posts only use the title.' }),
	field('x_url', 'string', { interface: 'input', readonly: true, group: 'social_group', width: 'half', note: 'Set after posting; clear it to post again.' }),
	field('reddit_url', 'string', { interface: 'input', readonly: true, group: 'social_group', width: 'half', note: 'Set after posting; clear it to post again.' }),

	field('published_at', 'timestamp', { interface: 'datetime', readonly: true, width: 'half' }),
	field('date_created', 'timestamp', { special: ['date-created'], interface: 'datetime', readonly: true, hidden: true, width: 'half' }),
	field('date_updated', 'timestamp', { special: ['date-updated'], interface: 'datetime', readonly: true, hidden: true, width: 'half' }),
];

// ---------- the writer_settings singleton ----------

const settingsFields = [
	field('model', 'string', { interface: 'input', note: 'OpenRouter model id, e.g. deepseek/deepseek-v4-flash-0731 or anthropic/claude-sonnet-5.5. See openrouter.ai/models.', width: 'half' }, { default_value: 'deepseek/deepseek-v4-flash-0731' }),
	field('social_language', 'string', {
		interface: 'select-dropdown',
		options: { choices: [{ text: 'English', value: 'en' }, { text: 'فارسی', value: 'fa' }] },
		note: 'Language of the tweet and Reddit post.',
		width: 'half',
	}, { default_value: 'en' }),
	field('reddit_subreddit', 'string', { interface: 'input', note: 'Where Reddit posts go, e.g. u_yourname (your profile) or a subreddit name.', width: 'half' }),
	field('reddit_kind', 'string', {
		interface: 'select-dropdown',
		options: { choices: [{ text: 'Link post', value: 'link' }, { text: 'Text post', value: 'self' }] },
		width: 'half',
	}, { default_value: 'link' }),
	field('system_prompt', 'text', { interface: 'input-rich-text-md', note: 'Instructions the AI follows when writing every post. Edit to change tone and structure.' }),
];

// ---------- apply ----------

async function ensureCollection(name, meta, fields) {
	const existing = await api('GET', `/collections/${name}`).catch(() => null);
	if (!existing) {
		await api('POST', '/collections', {
			collection: name,
			meta,
			schema: {},
			fields: [{ field: 'id', type: 'integer', meta: { hidden: true, interface: 'input', readonly: true }, schema: { is_primary_key: true, has_auto_increment: true } }],
		});
		console.log(`created collection ${name}`);
	}
	const have = new Set((await api('GET', `/fields/${name}`)).map((f) => f.field));
	for (const f of fields) {
		if (have.has(f.field)) continue;
		await api('POST', `/fields/${name}`, f);
		console.log(`  + ${name}.${f.field}`);
	}
}

async function ensureFileRelation() {
	const rel = await api('GET', '/relations/posts/audio').catch(() => null);
	if (rel) return;
	await api('POST', '/relations', {
		collection: 'posts',
		field: 'audio',
		related_collection: 'directus_files',
		schema: { on_delete: 'SET NULL' },
	});
	console.log('  + relation posts.audio → files');
}

async function ensureSettings() {
	const current = await api('GET', '/items/writer_settings');
	if (current?.system_prompt) return;
	const prompt = await fs.readFile(new URL('./default-prompt.md', import.meta.url), 'utf8');
	await api('PATCH', '/items/writer_settings', { system_prompt: prompt, model: 'deepseek/deepseek-v4-flash-0731', social_language: 'en', reddit_kind: 'link' });
	console.log('seeded writer_settings with the default prompt');
}

// Default columns for the posts list (for everyone, until someone changes their own view).
async function ensureListView() {
	const presets = await api('GET', '/presets?filter[collection][_eq]=posts&filter[user][_null]=true&filter[role][_null]=true&filter[bookmark][_null]=true');
	if (presets.length) return;
	await api('POST', '/presets', {
		collection: 'posts',
		layout: 'tabular',
		layout_query: { tabular: { fields: ['status', 'meeting_number', 'title_fa', 'title_en', 'published_at'], sort: ['-date_created'] } },
		layout_options: { tabular: { widths: { status: 190, meeting_number: 90, title_fa: 300, title_en: 300 } } },
	});
	console.log('set the default posts list columns');
}

async function ensureFlow() {
	const name = 'Send post events to n8n';
	const flows = await api('GET', `/flows?filter[name][_eq]=${encodeURIComponent(name)}`);
	if (flows.length) return;
	const flow = await api('POST', '/flows', {
		name,
		icon: 'send',
		color: '#FF6D5A',
		description: 'Every create/update on posts is forwarded to n8n, which decides what to do based on the status.',
		status: 'active',
		trigger: 'event',
		accountability: 'all',
		options: { type: 'action', scope: ['items.create', 'items.update'], collections: ['posts'] },
	});
	const op = await api('POST', '/operations', {
		flow: flow.id,
		name: 'POST to n8n',
		key: 'post_to_n8n',
		type: 'request',
		position_x: 19,
		position_y: 1,
		options: {
			method: 'POST',
			url: N8N_WEBHOOK_URL,
			headers: [{ header: 'X-Webhook-Secret', value: N8N_WEBHOOK_SECRET }, { header: 'Content-Type', value: 'application/json' }],
			body: '{{$trigger}}',
		},
	});
	await api('PATCH', `/flows/${flow.id}`, { operation: op.id });
	console.log(`created flow "${name}"`);
}

await waitForDirectus();
await ensureCollection('posts', {
	icon: 'article',
	note: 'Each meeting becomes one post. Paste a transcript and save to start.',
	display_template: '{{title}} — {{title_fa}}',
	sort_field: null,
	archive_field: null,
}, postFields);
await ensureFileRelation();
await ensureListView();
await ensureCollection('writer_settings', { icon: 'smart_toy', singleton: true, note: 'How the AI writes posts' }, settingsFields);
await ensureSettings();
await ensureFlow();
console.log('Directus is ready.');
