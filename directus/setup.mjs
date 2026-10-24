// Creates everything the blog needs inside Directus. Safe to run again: it only
// adds what is missing and never deletes or overwrites your content.
//
//   posts            one row per meeting → post (both languages, social texts, progress log)
//   writer_settings  prompts, models and social settings, editable in the panel
//   flow             "Send post events to n8n": every create/update on posts is POSTed to n8n
//
// Field labels, notes and order are kept in step with this file on every run;
// your posts' content is never touched.
//
// Usage: DIRECTUS_URL=… DIRECTUS_TOKEN=… N8N_WEBHOOK_URL=… N8N_WEBHOOK_SECRET=… node setup.mjs

import { createHash } from 'node:crypto';
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
const options = (list) => list.map(([value, text]) => ({ value, text: text ?? value }));

// ---------- models you can pick from (any other OpenRouter / STT id can be typed in too) ----------

const LLM_CHOICES = [
	'deepseek/deepseek-v4-flash-0731',
	'deepseek/deepseek-v4.1-flash',
	'deepseek/deepseek-v4-pro',
	'google/gemini-3.8-flash',
	'anthropic/claude-sonnet-5.5',
];
const STT_CHOICES = ['elevenlabs:scribe_v2', 'whisper:whisper-large-v3', 'whisper:whisper-large-v3-turbo'];
const DEFAULT_LLM = LLM_CHOICES[0];
const DEFAULT_STT = STT_CHOICES[0];

// ---------- the posts collection ----------

// You set the ones marked (you); the automation sets the others.
const STATUS = choices([
	['new', 'New — start (you)', '#A2B5CD'],
	['transcribing', 'Transcribing…', '#3399FF'],
	['writing', 'AI is writing…', '#3399FF'],
	['translating', 'Translating…', '#3399FF'],
	['review', 'Ready for review', '#FFA439'],
	['revise', 'Revise with AI, uses Feedback (you)', '#9B51E0'],
	['retry', 'Retry — from the failed step or "Restart from" (you)', '#9B51E0'],
	['approved', 'Approved — publish now (you)', '#2ECDA7'],
	['publishing', 'Publishing…', '#3399FF'],
	['published', 'Published', '#00C897'],
	['archived', 'Removed from site (you)', '#737373'],
	['error', 'Error — see message', '#E35169'],
]);

const STAGE_CHOICES = options([
	['transcribe', 'Transcription'],
	['write', 'Writing'],
	['translate', 'Translation'],
	['publish', 'Publishing'],
	['remove', 'Removing from site'],
]);

const postFields = [
	field('status', 'string', {
		interface: 'select-dropdown',
		display: 'labels',
		options: { choices: STATUS },
		display_options: { showAsDot: false, choices: STATUS },
		note: 'Move the post along: New starts it, Revise rewrites it with your Feedback, Retry continues after an error, Approved publishes, Removed takes it off the site.',
		width: 'half',
		required: true,
	}, { default_value: 'new', is_nullable: false }),
	field('slug', 'string', { interface: 'input', note: 'Part of the post URL, e.g. /fa/blog/rag-basics/ — the AI suggests one.', width: 'half', options: { slug: true } }, { is_unique: true }),
	field('error_message', 'text', {
		interface: 'input-multiline', readonly: true,
		translations: [{ language: 'en-US', translation: 'Error' }],
		note: 'Full error from the failed step. Fix the cause (or pick another model below), then set the status to "Retry".',
		conditions: [{ name: 'hide when empty', rule: { error_message: { _null: true } }, hidden: true }],
	}),

	group('progress_group', '0 · Progress and models'),
	field('current_stage', 'string', {
		interface: 'select-dropdown', readonly: true, group: 'progress_group', width: 'half',
		options: { choices: STAGE_CHOICES }, display: 'formatted-value',
		translations: [{ language: 'en-US', translation: 'Current / last step' }],
	}),
	field('restart_from', 'string', {
		interface: 'select-dropdown', group: 'progress_group', width: 'half',
		options: { choices: STAGE_CHOICES.filter((c) => c.value !== 'remove'), allowNone: true, placeholder: 'the failed step' },
		translations: [{ language: 'en-US', translation: 'Restart from' }],
		note: 'Used when you set the status to Retry. Empty = the step that failed.',
	}),
	field('stt_model', 'string', {
		interface: 'select-dropdown', group: 'progress_group', width: 'half',
		options: { choices: options(STT_CHOICES.map((m) => [m])), allowOther: true, allowNone: true, placeholder: 'Writer Settings default' },
		translations: [{ language: 'en-US', translation: 'Speech-to-text model (this post)' }],
		note: 'Empty = the default in Writer Settings.',
	}),
	field('llm_model', 'string', {
		interface: 'select-dropdown', group: 'progress_group', width: 'half',
		options: { choices: options(LLM_CHOICES.map((m) => [m])), allowOther: true, allowNone: true, placeholder: 'Writer Settings default' },
		translations: [{ language: 'en-US', translation: 'AI model (this post)' }],
		note: 'Used for writing and translation. Any OpenRouter model id works. Empty = the default in Writer Settings.',
	}),
	field('detected_language', 'string', {
		interface: 'select-dropdown', readonly: true, group: 'progress_group', width: 'half',
		options: { choices: options([['fa', 'Persian'], ['en', 'English']]) },
		translations: [{ language: 'en-US', translation: 'Recording language (detected)' }],
	}),
	field('error_stage', 'string', { interface: 'input', readonly: true, hidden: true, group: 'progress_group', width: 'half' }),
	field('pipeline_log', 'text', {
		interface: 'input-multiline', readonly: true, group: 'progress_group',
		translations: [{ language: 'en-US', translation: 'Progress log' }],
		note: 'Every step with its time, model and result. The same messages go to Telegram.',
	}),
	field('run_id', 'string', { interface: 'input', readonly: true, hidden: true }),

	group('input_group', '1 · Meeting (input)'),
	field('title', 'string', { interface: 'input', group: 'input_group', width: 'half', note: 'Working title (optional)' }),
	field('meeting_number', 'integer', { interface: 'input', group: 'input_group', width: 'half' }),
	field('source_language', 'string', {
		interface: 'select-dropdown', group: 'input_group', width: 'half',
		options: { choices: options([['fa', 'Persian'], ['en', 'English']]), allowNone: true, placeholder: 'Detect automatically' },
		translations: [{ language: 'en-US', translation: 'Language of the meeting' }],
		note: 'The post is written in this language, then translated into the other one.',
	}),
	field('audio', 'uuid', {
		interface: 'file', special: ['file'], group: 'input_group', width: 'half',
		translations: [{ language: 'en-US', translation: 'Recording (audio or video)' }],
		note: 'Upload the meeting recording (up to 5 GB). Video is fine: only the sound is used.',
	}),
	field('recording_url', 'string', {
		interface: 'input', group: 'input_group', width: 'half',
		translations: [{ language: 'en-US', translation: 'Or a Google Drive link' }],
		options: { placeholder: 'https://drive.google.com/file/d/…' },
		note: 'Share the file as "Anyone with the link". Any direct link to an audio/video file works too.',
	}),
	field('transcript_file', 'uuid', {
		interface: 'file', special: ['file'], group: 'input_group', width: 'half',
		translations: [{ language: 'en-US', translation: 'Or a transcript file' }],
		note: 'For long transcripts: .txt, .md, .srt, .vtt, .docx or .pdf. Used instead of the recording.',
	}),
	field('transcript', 'text', {
		interface: 'input-multiline', group: 'input_group',
		note: 'Filled in automatically from the recording or transcript file. You can also paste a transcript yourself; then nothing is transcribed.',
	}),
	field('keyterms', 'json', {
		interface: 'tags', special: ['cast-json'], group: 'input_group',
		translations: [{ language: 'en-US', translation: 'Names and terms' }],
		note: 'Names and technical terms said in this meeting, so the transcription spells them right (press Enter after each).',
	}),
	field('notes', 'text', { interface: 'input-multiline', group: 'input_group', note: 'Optional notes for the AI writer: what to focus on, what to leave out.' }),
	field('feedback', 'text', { interface: 'input-multiline', group: 'input_group', note: 'What should the AI change? Write it here, then set the status to "Revise with AI".' }),

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
	group('ai_group', 'AI writing and translation'),
	field('model', 'string', {
		interface: 'select-dropdown', group: 'ai_group', width: 'half',
		options: { choices: options(LLM_CHOICES.map((m) => [m])), allowOther: true },
		translations: [{ language: 'en-US', translation: 'Default AI model' }],
		note: 'OpenRouter model id. Each post can override it. See openrouter.ai/models.',
	}, { default_value: DEFAULT_LLM }),
	field('reasoning_effort', 'string', {
		interface: 'select-dropdown', group: 'ai_group', width: 'half',
		options: { choices: options([['low', 'Low (fast, leaves more room for the text)'], ['medium', 'Medium'], ['high', 'High']]) },
		note: 'How much the model thinks before writing. Thinking uses the same output budget as the text.',
	}, { default_value: 'low' }),
	field('max_output_tokens', 'integer', {
		interface: 'input', group: 'ai_group', width: 'half',
		note: 'Upper limit for one answer (thinking + text). Raise it if posts get cut off, up to the model\'s own limit.',
	}, { default_value: 64000 }),
	field('llm_choices', 'json', {
		interface: 'tags', special: ['cast-json'], group: 'ai_group',
		translations: [{ language: 'en-US', translation: 'AI models offered in Telegram' }],
	}),
	field('system_prompt', 'text', {
		interface: 'input-rich-text-md', group: 'ai_group',
		translations: [{ language: 'en-US', translation: 'Writing prompt' }],
		note: 'How the AI writes the post in the meeting\'s language.',
	}),
	field('translation_prompt', 'text', {
		interface: 'input-rich-text-md', group: 'ai_group',
		translations: [{ language: 'en-US', translation: 'Translation prompt' }],
		note: 'How the AI translates the post into the other language and writes the X / Reddit texts.',
	}),

	group('stt_group', 'Speech to text'),
	field('stt_model', 'string', {
		interface: 'select-dropdown', group: 'stt_group', width: 'half',
		options: { choices: options(STT_CHOICES.map((m) => [m])), allowOther: true },
		translations: [{ language: 'en-US', translation: 'Default speech-to-text model' }],
		note: 'elevenlabs:<model> needs ELEVENLABS_API_KEY; whisper:<model> needs TRANSCRIBE_API_KEY (Groq) on the server.',
	}, { default_value: DEFAULT_STT }),
	field('transcription_language', 'string', {
		interface: 'input', group: 'stt_group', width: 'half', options: { placeholder: 'auto' },
		note: 'Leave empty to detect automatically (best for Persian mixed with English), or e.g. fa / en.',
	}),
	field('stt_choices', 'json', {
		interface: 'tags', special: ['cast-json'], group: 'stt_group',
		translations: [{ language: 'en-US', translation: 'Speech-to-text models offered in Telegram' }],
	}),
	field('keyterms', 'json', {
		interface: 'tags', special: ['cast-json'], group: 'stt_group',
		translations: [{ language: 'en-US', translation: 'Names and terms (every meeting)' }],
		note: 'Names and terms that come up in most meetings, e.g. your names, tools you use. Added to every transcription.',
	}),

	group('social_settings_group', 'X and Reddit'),
	field('social_language', 'string', {
		interface: 'select-dropdown', group: 'social_settings_group', width: 'half',
		options: { choices: [{ text: 'English', value: 'en' }, { text: 'فارسی', value: 'fa' }] },
		note: 'Language of the tweet and Reddit post.',
	}, { default_value: 'en' }),
	field('reddit_kind', 'string', {
		interface: 'select-dropdown', group: 'social_settings_group', width: 'half',
		options: { choices: [{ text: 'Link post', value: 'link' }, { text: 'Text post', value: 'self' }] },
	}, { default_value: 'link' }),
	field('reddit_subreddit', 'string', { interface: 'input', group: 'social_settings_group', width: 'half', note: 'Where Reddit posts go, e.g. u_yourname (your profile) or a subreddit name.' }),
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
	} else {
		await api('PATCH', `/collections/${name}`, { meta });
	}
	const have = new Set((await api('GET', `/fields/${name}`)).map((f) => f.field));
	for (const f of fields) {
		if (have.has(f.field)) {
			// keep labels, notes, choices and order in step with this file (content is untouched)
			await api('PATCH', `/fields/${name}/${f.field}`, { meta: f.meta });
			continue;
		}
		await api('POST', `/fields/${name}`, f);
		console.log(`  + ${name}.${f.field}`);
	}
}

async function removeFields(name, list) {
	const have = new Set((await api('GET', `/fields/${name}`)).map((f) => f.field));
	for (const gone of list.filter((f) => have.has(f))) {
		await api('DELETE', `/fields/${name}/${gone}`);
		console.log(`  - ${name}.${gone}`);
	}
}

async function ensureFileRelation(field) {
	const rel = await api('GET', `/relations/posts/${field}`).catch(() => null);
	if (rel) return;
	await api('POST', '/relations', { collection: 'posts', field, related_collection: 'directus_files', schema: { on_delete: 'SET NULL' } });
	console.log(`  + relation posts.${field} → files`);
}

const readPrompt = (name) => fs.readFile(new URL(`./prompts/${name}`, import.meta.url), 'utf8');
const sha = (s) => createHash('sha256').update(s || '').digest('hex');
// The first (bilingual, one-step) writing prompt. If it was never edited, it's replaced.
const OLD_DEFAULT_PROMPT = 'e40c1a333f39d6e29f57a5acd2181c8aa7d9b0f0705980b1420deb23822d12a1';

async function ensureSettings(oldProvider) {
	const s = (await api('GET', '/items/writer_settings')) || {};
	const patch = {};
	if (!s.system_prompt || sha(s.system_prompt) === OLD_DEFAULT_PROMPT) patch.system_prompt = await readPrompt('writer.md');
	if (!s.translation_prompt) patch.translation_prompt = await readPrompt('translator.md');
	if (!s.model) patch.model = DEFAULT_LLM;
	if (!s.stt_model) patch.stt_model = oldProvider === 'whisper' ? 'whisper:whisper-large-v3' : DEFAULT_STT;
	if (!s.reasoning_effort) patch.reasoning_effort = 'low';
	if (!s.max_output_tokens) patch.max_output_tokens = 64000;
	if (!s.llm_choices?.length) patch.llm_choices = LLM_CHOICES;
	if (!s.stt_choices?.length) patch.stt_choices = STT_CHOICES;
	if (!s.social_language) patch.social_language = 'en';
	if (!s.reddit_kind) patch.reddit_kind = 'link';
	if (Object.keys(patch).length) {
		await api('PATCH', '/items/writer_settings', patch);
		console.log(`writer_settings: set ${Object.keys(patch).join(', ')}`);
	}
}

// Posts left in a status that no longer exists are moved to "error", so they can be retried.
async function migratePosts() {
	const stuck = await api('GET', '/items/posts?filter[status][_eq]=processing&fields=id,error_message');
	for (const p of stuck) {
		await api('PATCH', `/items/posts/${p.id}`, {
			status: 'error',
			error_stage: 'write',
			current_stage: 'write',
			error_message: [p.error_message, 'Stopped by an update of the automation. Set the status to "Retry" to continue.'].filter(Boolean).join('\n\n'),
		});
		console.log(`post ${p.id}: processing → error (can be retried)`);
	}
}

// Default columns for the posts list (for everyone, until someone changes their own view).
async function ensureListView() {
	const presets = await api('GET', '/presets?filter[collection][_eq]=posts&filter[user][_null]=true&filter[role][_null]=true&filter[bookmark][_null]=true');
	const view = {
		layout: 'tabular',
		layout_query: { tabular: { fields: ['status', 'current_stage', 'meeting_number', 'title_fa', 'title_en', 'published_at'], sort: ['-date_created'] } },
		layout_options: { tabular: { widths: { status: 190, current_stage: 130, meeting_number: 90, title_fa: 280, title_en: 280 } } },
	};
	if (presets.length) await api('PATCH', `/presets/${presets[0].id}`, view);
	else await api('POST', '/presets', { collection: 'posts', ...view });
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
	note: 'Each meeting becomes one post. Upload the recording or a transcript file (or paste a Drive link or the transcript) and save to start.',
	display_template: '{{title}} — {{title_fa}}',
	sort_field: null,
	archive_field: null,
}, postFields);
await removeFields('posts', ['transcribe_audio']);
await ensureFileRelation('audio');
await ensureFileRelation('transcript_file');
await ensureListView();
const oldProvider = (await api('GET', '/items/writer_settings').catch(() => null))?.transcription_provider;
await ensureCollection('writer_settings', { icon: 'smart_toy', singleton: true, note: 'How recordings are transcribed and how the AI writes and translates posts' }, settingsFields);
await ensureSettings(oldProvider);
await removeFields('writer_settings', ['transcription_provider']);
await migratePosts();
await ensureFlow();
console.log('Directus is ready.');
