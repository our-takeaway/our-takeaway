// Builds the n8n workflows in ./workflows from readable code.
//
//   node n8n/build-workflows.mjs
//
// After the first import, n8n's own database is what runs. If you edit a workflow
// in the n8n editor, export it (see n8n/README.md) — or make the change here and
// re-import, so this file stays the source of truth.

import fs from 'node:fs';
import { createHash } from 'node:crypto';

const OUT = new URL('./workflows/', import.meta.url);
const PIPELINE_ID = 'BlogPipeline0001';
const ERRORS_ID = 'PipelineErrors01';

// Stable ids so re-generating doesn't churn the files.
const uid = (s) => {
	const h = createHash('sha1').update(s).digest('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

function workflow(id, name) {
	const nodes = [];
	const connections = {};
	const w = {
		id, name, nodes, connections,
		node(nodeName, type, typeVersion, [x, y], parameters, extra = {}) {
			nodes.push({ id: uid(`${id}/${nodeName}`), name: nodeName, type, typeVersion, position: [x, y], parameters, ...extra });
			return nodeName;
		},
		connect(from, to, output = 0) {
			connections[from] ??= { main: [] };
			while (connections[from].main.length <= output) connections[from].main.push([]);
			connections[from].main[output].push({ node: to, type: 'main', index: 0 });
		},
		chain(...names) {
			for (let i = 0; i < names.length - 1; i++) w.connect(names[i], names[i + 1]);
			return names.at(-1);
		},
		note(key, content, [x, y], [width, height], color = 7) {
			nodes.push({ id: uid(`${id}/note/${key}`), name: `Note: ${key}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y], parameters: { content, width, height, color } });
		},
	};
	return w;
}

// ---------- node helpers ----------

const DIRECTUS = '{{ $env.DIRECTUS_URL }}';
const WORKER = '{{ $env.WORKER_URL }}';
const directusAuth = { name: 'Authorization', value: '=Bearer {{ $env.DIRECTUS_TOKEN }}' };
const workerAuth = { name: 'Authorization', value: '=Bearer {{ $env.WORKER_SECRET }}' };

function http(w, name, pos, { method = 'GET', url, headers = [directusAuth], body, timeout, onError }) {
	const parameters = { method, url, sendHeaders: true, headerParameters: { parameters: headers }, options: timeout ? { timeout } : {} };
	if (body) Object.assign(parameters, { sendBody: true, specifyBody: 'json', jsonBody: body });
	return w.node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, parameters, onError ? { onError } : {});
}
const code = (w, name, pos, jsCode, mode = 'runOnceForEachItem') => w.node(name, 'n8n-nodes-base.code', 2, pos, { mode, jsCode: jsCode.trim() });

function ifTrue(w, name, pos, expression) {
	return w.node(name, 'n8n-nodes-base.if', 2.2, pos, {
		conditions: {
			options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
			conditions: [{ id: uid(`${name}/c`), leftValue: `={{ ${expression} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
			combinator: 'and',
		},
		looseTypeValidation: true,
		options: {},
	});
}

const POST_ID = "$('Where to start').item.json.id";
const getPost = (w, name, pos) => http(w, name, pos, { url: `=${DIRECTUS}/items/posts/{{ ${POST_ID} }}` });
const getSettings = (w, name, pos) => http(w, name, pos, { url: `=${DIRECTUS}/items/writer_settings` });
const patchPost = (w, name, pos, bodyExpr, extra = {}) =>
	http(w, name, pos, { method: 'PATCH', url: `=${DIRECTUS}/items/posts/{{ ${POST_ID} }}`, body: `={{ JSON.stringify(${bodyExpr}) }}`, ...extra });
// Report a step to the worker → post status, progress log, Telegram.
const report = (w, name, pos, stage, state, infoExpr = '{}') =>
	http(w, name, pos, {
		method: 'POST', url: `=${WORKER}/stage`, headers: [workerAuth],
		body: `={{ JSON.stringify({ postId: ${POST_ID}, stage: "${stage}", state: "${state}", info: ${infoExpr} }) }}`,
	});
const openRouter = (w, name, pos, requestNode) =>
	http(w, name, pos, {
		method: 'POST',
		url: '={{ $env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1" }}/chat/completions',
		headers: [{ name: 'Authorization', value: '=Bearer {{ $env.OPENROUTER_API_KEY }}' }, { name: 'X-Title', value: 'Our Takeaway' }],
		body: `={{ JSON.stringify($('${requestNode}').item.json.request) }}`,
		timeout: 900000,
	});

// Shared bits of the Code nodes (they run inside n8n).
const DETECT = `const detect = (t) => { const fa = (t.match(/[\\u0600-\\u06FF]/g) || []).length; const en = (t.match(/[A-Za-z]/g) || []).length; return fa > en * 0.5 ? 'fa' : 'en'; };`;
const NAMES = `const NAMES = { fa: 'Persian (fa)', en: 'English (en)' };`;
const CHECK_ANSWER = (what) => `
const req = $('Build the ${what} request').item.json;
const choice = $json.choices?.[0];
if (!choice) throw new Error(\`The AI model \${req.model} returned no answer. Full response: \${JSON.stringify($json)}\`);
if (choice.finish_reason === 'length') {
  throw new Error(
    \`The AI model \${req.model} ran out of output space while ${what === 'writing' ? 'writing' : 'translating'} \` +
    \`(used \${$json.usage?.completion_tokens ?? '?'} of max \${req.request.max_tokens} tokens, thinking included). \` +
    \`Fix: pick a model with a larger output limit for this post ("AI model (this post)" or 🤖 Change model in Telegram), \` +
    \`set "Reasoning effort" to Low, or raise "Max output tokens" in Writer Settings. Then Retry.\`);
}
let out;
try { out = JSON.parse(choice.message.content); }
catch (e) { throw new Error(\`The AI model \${req.model} did not return valid JSON (\${e.message}). Answer was: \${String(choice.message.content)}\`); }
for (const k of ['title', 'body']) if (!String(out[k] || '').trim()) throw new Error(\`The AI model \${req.model} left "\${k}" empty. Answer was: \${choice.message.content}\`);
const tags = (t) => [...new Set((t || []).map((x) => String(x).trim().replace(/^#/, '')).filter(Boolean))].slice(0, 6);
`;

// =====================================================================
// Post pipeline
// =====================================================================

const p = workflow(PIPELINE_ID, 'Post pipeline');

p.note('overview',
	'## Post pipeline\nDirectus sends every change to a **post** here. The new **status** decides what runs:\n' +
	'- **new** → transcription → writing (meeting language) → translation → *review*\n' +
	'- **revise** → writing with your feedback → translation\n' +
	'- **retry** → from the step that failed (or "Restart from")\n' +
	'- **approved** → publish · **archived** → remove from site\n\n' +
	'Every step reports to the worker (**Report: …** nodes): status, progress log, Telegram. ' +
	'Any failure anywhere is caught by the **Pipeline errors** workflow.', [-320, -560], [560, 300], 4);

// ---- entry ----
const hook = p.node('Directus: post changed', 'n8n-nodes-base.webhook', 2, [-260, 200],
	{ httpMethod: 'POST', path: 'directus-posts', responseMode: 'onReceived', options: {} }, { webhookId: uid('webhook/directus-posts') });

const decide = code(p, 'Decide what to run', [-40, 200], `
// Directus Flow sends { event, keys | key, payload }. Only statuses a person sets start work;
// the ones the automation writes (transcribing, writing, review, …) end here, so nothing loops.
const ACT = ['new', 'revise', 'retry', 'approved', 'archived'];
const out = [];
for (const item of $input.all()) {
  const secret = item.json.headers['x-webhook-secret'];
  if (!secret || secret !== $env.N8N_WEBHOOK_SECRET) throw new Error('Wrong webhook secret');
  const body = item.json.body;
  const ids = body.keys ?? (body.key != null ? [body.key] : []);
  const created = String(body.event).endsWith('.create');
  const status = body.payload?.status ?? (created ? 'new' : null);
  if (ACT.includes(status)) for (const id of ids) out.push({ json: { id, status } });
}
return out;`, 'runOnceForAllItems');

const firstGet = http(p, 'Get the post', [180, 200], { url: `=${DIRECTUS}/items/posts/{{ $json.id }}` });

const where = code(p, 'Where to start', [400, 200], `
const ev = $('Decide what to run').item.json;
const post = $json.data;
const hasSource = Boolean(post.transcript_file || post.audio || post.recording_url?.trim());
let route = null, start = null, force = false;
if (ev.status === 'new') { route = 'generate'; start = 'transcribe'; }
if (ev.status === 'revise') { route = 'generate'; start = 'write'; }
if (ev.status === 'approved') route = 'publish';
if (ev.status === 'archived') route = 'remove';
if (ev.status === 'retry') {
  const from = post.restart_from || post.error_stage || post.current_stage || 'transcribe';
  if (from === 'publish' || from === 'remove') route = from;
  else { route = 'generate'; start = from; force = post.restart_from === 'transcribe' && hasSource; }
}
return { json: { id: post.id, status: ev.status, route, start, force } };`);

const claim = patchPost(p, 'Claim this run', [620, 200], '{ run_id: String($execution.id), restart_from: null }');

const route = p.node('Route', 'n8n-nodes-base.switch', 3.2, [840, 200], {
	rules: {
		values: [['Generate', 'generate'], ['Publish', 'publish'], ['Remove', 'remove']].map(([key, value]) => ({
			conditions: {
				options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
				conditions: [{ id: uid(`route/${value}`), leftValue: "={{ $('Where to start').item.json.route }}", rightValue: value, operator: { type: 'string', operation: 'equals' } }],
				combinator: 'and',
			},
			renameOutput: true,
			outputKey: key,
		})),
	},
	options: {},
});
p.chain(hook, decide, firstGet, where, claim, route);

// ---- 1. transcription ----
p.note('transcribe', '### 1 · Transcription\nSkipped when the post already has a transcript (unless you restart from here). ' +
	'The worker reads the transcript file, or downloads the recording / Drive link, keeps only the voice and sends it to the speech-to-text model (post\'s choice or Writer Settings).', [1060, -420], [620, 150], 5);
const needTranscript = ifTrue(p, 'Transcribe?', [1100, -100],
	"$('Where to start').item.json.start === 'transcribe' && ($('Where to start').item.json.force || !$('Get the post').item.json.data.transcript?.trim())");
p.connect(route, needTranscript, 0);
const tStart = report(p, 'Report: transcription started', [1320, -220], 'transcribe', 'start');
const tRun = http(p, 'Transcribe (worker)', [1540, -220], { method: 'POST', url: `=${WORKER}/transcribe`, headers: [workerAuth], body: `={{ JSON.stringify({ postId: ${POST_ID} }) }}`, timeout: 3600000 });
const tSave = patchPost(p, 'Save the transcript', [1760, -220], "{ transcript: $('Transcribe (worker)').item.json.text, detected_language: $('Transcribe (worker)').item.json.language }");
const tDone = report(p, 'Report: transcription done', [1980, -220], 'transcribe', 'done',
	"(({ model, language, chars, seconds }) => ({ model, language, chars, seconds }))($('Transcribe (worker)').item.json)");
p.connect(needTranscript, tStart, 0);
p.chain(tStart, tRun, tSave, tDone);

// ---- 2. writing (in the meeting's language) ----
p.note('write', '### 2 · Writing\nThe post is written in the meeting\'s language with the **Writing prompt** from Writer Settings. With status *revise*, the current draft and your Feedback are sent too.', [1060, 360], [620, 130], 5);
const needWrite = ifTrue(p, 'Write?', [2200, 100], "['transcribe', 'write'].includes($('Where to start').item.json.start)");
p.connect(needTranscript, needWrite, 1);
p.connect(tDone, needWrite);

const wPost = getPost(p, 'Get the post (writing)', [2420, 0]);
const wSettings = getSettings(p, 'Get writer settings (writing)', [2640, 0]);
const wBuild = code(p, 'Build the writing request', [2860, 0], `
const post = $('Get the post (writing)').item.json.data;
const s = $('Get writer settings (writing)').item.json.data;
const start = $('Where to start').item.json;
${DETECT}
${NAMES}
const transcript = (post.transcript || '').trim();
if (!transcript) throw new Error('There is no transcript to write from. Upload a recording or a transcript file, paste a Google Drive link or the transcript, then set the status to New.');
const lang = ['fa', 'en'].includes(post.source_language) ? post.source_language : (post.detected_language || detect(transcript));
const model = post.llm_model || s.model || 'deepseek/deepseek-v4-flash-0731';
const meeting = [
  post.title ? \`Working title: \${post.title}\` : '',
  post.meeting_number != null ? \`Meeting number: \${post.meeting_number}\` : '',
  \`Date: \${(post.date_created || new Date().toISOString()).slice(0, 10)}\`,
  post.notes ? \`Notes from the hosts:\\n\${post.notes}\` : '',
].filter(Boolean).join('\\n');
const material = [\`Write the entry in: \${NAMES[lang]}\`, \`<meeting>\\n\${meeting}\\n</meeting>\`, \`<transcript>\\n\${transcript}\\n</transcript>\`];
if (start.status === 'revise' && post.feedback?.trim() && post['body_' + lang]) {
  const current = { slug: post.slug, title: post['title_' + lang], description: post['description_' + lang], tags: post['tags_' + lang], body: post['body_' + lang] };
  material.push(\`<current_draft>\\n\${JSON.stringify(current, null, 2)}\\n</current_draft>\`, \`<reviewer_feedback>\\n\${post.feedback}\\n</reviewer_feedback>\`);
}
const str = { type: 'string' };
const fields = { slug: str, title: str, description: str, tags: { type: 'array', items: str }, body: str };
return { json: { lang, model, request: {
  model,
  max_tokens: Number(s.max_output_tokens) || 64000,
  reasoning: { effort: s.reasoning_effort || 'low' },
  messages: [{ role: 'system', content: s.system_prompt }, { role: 'user', content: material.join('\\n\\n') }],
  response_format: { type: 'json_schema', json_schema: { name: 'entry', strict: true, schema: { type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false } } },
} } };`);
const wStart = report(p, 'Report: writing started', [3080, 0], 'write', 'start',
	"{ model: $('Build the writing request').item.json.model, lang: $('Build the writing request').item.json.lang }");
const wAsk = openRouter(p, 'Ask the AI to write', [3300, 0], 'Build the writing request');
const wCheck = code(p, 'Check the draft', [3520, 0], `
${CHECK_ANSWER('writing')}
const post = $('Get the post (writing)').item.json.data;
const lang = req.lang;
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
return { json: { fields: {
  slug: post.published_at && post.slug ? post.slug : slugify(out.slug) || \`post-\${post.id}\`,
  ['title_' + lang]: out.title.trim(),
  ['description_' + lang]: String(out.description || '').trim(),
  ['tags_' + lang]: tags(out.tags),
  ['body_' + lang]: out.body.trim() + '\\n',
  detected_language: lang,
  feedback: null,
}, chars: out.body.length } };`);
const wSlug = http(p, 'Is the slug taken?', [3740, 0], {
	url: `=${DIRECTUS}/items/posts?filter[slug][_eq]={{ encodeURIComponent($json.fields.slug) }}&filter[id][_neq]={{ ${POST_ID} }}&fields=id&limit=1`,
});
const wFree = code(p, 'Use a free slug', [3960, 0], `
// Another post already uses this slug → add this post's number to keep URLs unique.
const fields = { ...$('Check the draft').item.json.fields };
if ($json.data?.length) fields.slug = \`\${fields.slug}-\${$('Where to start').item.json.id}\`;
return { json: fields };`);
const wSave = patchPost(p, 'Save the draft', [4180, 0], '$json');
const wDone = report(p, 'Report: writing done', [4400, 0], 'write', 'done',
	"{ model: $('Build the writing request').item.json.model, lang: $('Build the writing request').item.json.lang, chars: $('Check the draft').item.json.chars }");
p.connect(needWrite, wPost, 0);
p.chain(wPost, wSettings, wBuild, wStart, wAsk, wCheck, wSlug, wFree, wSave, wDone);

// ---- 3. translation ----
p.note('translate', '### 3 · Translation\nThe finished draft is translated into the other language with the **Translation prompt**, which also writes the X / Reddit texts. Status → *review*; the drafts go to Telegram.', [3080, 360], [620, 130], 5);
const trPost = getPost(p, 'Get the post (translation)', [4620, 200]);
p.connect(needWrite, trPost, 1);
p.connect(wDone, trPost);
const trSettings = getSettings(p, 'Get writer settings (translation)', [4840, 200]);
const trBuild = code(p, 'Build the translation request', [5060, 200], `
const post = $('Get the post (translation)').item.json.data;
const s = $('Get writer settings (translation)').item.json.data;
${NAMES}
const from = ['fa', 'en'].includes(post.source_language) ? post.source_language : (post.detected_language || (post.body_fa ? 'fa' : 'en'));
const to = from === 'fa' ? 'en' : 'fa';
if (!post['body_' + from]?.trim()) throw new Error(\`There is no \${NAMES[from]} draft to translate yet. Set "Restart from" to Writing and the status to Retry.\`);
const model = post.llm_model || s.model || 'deepseek/deepseek-v4-flash-0731';
const source = { title: post['title_' + from], description: post['description_' + from], tags: post['tags_' + from] || [], body: post['body_' + from] };
const str = { type: 'string' };
const fields = { title: str, description: str, tags: { type: 'array', items: str }, body: str, tweet: str, reddit_title: str, reddit_body: str };
const user = [
  \`Translate from \${NAMES[from]} into: \${NAMES[to]}\`,
  \`Social language: \${NAMES[s.social_language || 'en']}\`,
  \`<entry>\\n\${JSON.stringify(source, null, 2)}\\n</entry>\`,
].join('\\n\\n');
return { json: { from, to, model, request: {
  model,
  max_tokens: Number(s.max_output_tokens) || 64000,
  reasoning: { effort: s.reasoning_effort || 'low' },
  messages: [{ role: 'system', content: s.translation_prompt }, { role: 'user', content: user }],
  response_format: { type: 'json_schema', json_schema: { name: 'translation', strict: true, schema: { type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false } } },
} } };`);
const trStart = report(p, 'Report: translation started', [5280, 200], 'translate', 'start',
	"{ model: $('Build the translation request').item.json.model, from: $('Build the translation request').item.json.from, to: $('Build the translation request').item.json.to }");
const trAsk = openRouter(p, 'Ask the AI to translate', [5500, 200], 'Build the translation request');
const trCheck = code(p, 'Check the translation', [5720, 200], `
${CHECK_ANSWER('translation')}
const to = req.to;
return { json: {
  ['title_' + to]: out.title.trim(),
  ['description_' + to]: String(out.description || '').trim(),
  ['tags_' + to]: tags(out.tags),
  ['body_' + to]: out.body.trim() + '\\n',
  tweet: String(out.tweet || '').trim(),
  reddit_title: String(out.reddit_title || '').trim().slice(0, 300),
  reddit_body: String(out.reddit_body || '').trim(),
} };`);
const trSave = patchPost(p, 'Save the translation', [5940, 200], '$json');
const trDone = report(p, 'Report: translation done (→ review)', [6160, 200], 'translate', 'done',
	"{ model: $('Build the translation request').item.json.model, from: $('Build the translation request').item.json.from, to: $('Build the translation request').item.json.to }");
p.chain(trPost, trSettings, trBuild, trStart, trAsk, trCheck, trSave, trDone);

// ---- publish ----
p.note('publish', '### Publish\nRebuild the static site (the worker pulls published posts from Directus), then post on X and Reddit once — a saved link means it was already posted. A failed X / Reddit post is reported but does not undo the publish.', [1060, 700], [620, 140], 6);
const pubStart = report(p, 'Report: publishing started', [1100, 900], 'publish', 'start');
p.connect(route, pubStart, 1);
const pubPost = getPost(p, 'Get the post to publish', [1320, 900]);
const pubReady = code(p, 'Ready to publish?', [1540, 900], `
const post = $json.data;
if (!post.slug) throw new Error('This post has no slug yet. Let the AI finish the draft, or fill in the slug, then set the status to Approved again.');
const langs = ['fa', 'en'].filter((l) => post['title_' + l]?.trim() && post['body_' + l]?.trim());
if (!langs.length) throw new Error('This post has no title and text in either language yet.');
return { json: { published_at: post.published_at || new Date().toISOString(), langs } };`);
const pubDate = patchPost(p, 'Set the publish date', [1760, 900], '{ published_at: $json.published_at }');
const pubBuild = http(p, 'Rebuild the site', [1980, 900], { method: 'POST', url: `=${WORKER}/build`, headers: [workerAuth], timeout: 600000 });
const pubSettings = getSettings(p, 'Get social settings', [2200, 900]);
const pubPrep = code(p, 'Prepare social posts', [2420, 900], `
const post = $('Get the post to publish').item.json.data;
const s = $json.data;
const langs = $('Ready to publish?').item.json.langs;
const lang = langs.includes(s.social_language || 'en') ? (s.social_language || 'en') : langs[0];
const url = \`\${$env.SITE_URL}/\${lang}/blog/\${post.slug}/\`;
const xMax = 280 - 23 - 2; // links always count as 23 characters on X
const tweet = (post.tweet || post['title_' + lang] || '').trim();
return { json: {
  url,
  tweetText: (tweet.length > xMax ? tweet.slice(0, xMax - 1) + '…' : tweet) + '\\n\\n' + url,
  toX: post.share_x === true && !post.x_url && $env.X_ENABLED === 'true',
  toReddit: post.share_reddit === true && !post.reddit_url && !!s.reddit_subreddit && $env.REDDIT_ENABLED === 'true',
  subreddit: (s.reddit_subreddit || '').replace(/^\\/?r\\//, ''),
  redditKind: s.reddit_kind || 'link',
  redditTitle: post.reddit_title || post['title_' + lang],
  redditText: (post.reddit_body || '') + '\\n\\n' + url,
} };`);
const xIf = ifTrue(p, 'Post on X?', [2640, 900], '$json.toX');
const x = p.node('Post on X', 'n8n-nodes-base.twitter', 2, [2860, 800], { text: "={{ $('Prepare social posts').item.json.tweetText }}", additionalFields: {} }, { onError: 'continueRegularOutput', credentials: {} });
const xSave = patchPost(p, 'Save the X link', [3080, 800], '$json.error ? {} : { x_url: "https://x.com/i/web/status/" + ($json.id ?? $json.data?.id) }');
const rIf = ifTrue(p, 'Post on Reddit?', [3300, 900], "$('Prepare social posts').item.json.toReddit");
const reddit = p.node('Post on Reddit', 'n8n-nodes-base.reddit', 1, [3520, 800], {
	resource: 'post', operation: 'create',
	subreddit: "={{ $('Prepare social posts').item.json.subreddit }}",
	kind: "={{ $('Prepare social posts').item.json.redditKind }}",
	title: "={{ $('Prepare social posts').item.json.redditTitle }}",
	url: "={{ $('Prepare social posts').item.json.url }}",
	text: "={{ $('Prepare social posts').item.json.redditText }}",
	resubmit: true,
}, { onError: 'continueRegularOutput', credentials: {} });
const rSave = patchPost(p, 'Save the Reddit link', [3740, 800], '$json.error ? {} : { reddit_url: $json.url }');
const pubSum = code(p, 'Sum up the social posts', [3960, 900], `
const prep = $('Prepare social posts').item.json;
const result = (node, label) => {
  if (!$(node).isExecuted) return null;
  const r = $(node).item.json;
  if (r.error) return \`\${label}: FAILED — \${r.error.message || JSON.stringify(r.error)}\${r.error.description ? ' (' + r.error.description + ')' : ''}\`;
  return \`\${label}: posted\`;
};
return { json: { url: prep.url, x: result('Post on X', 'X'), reddit: result('Post on Reddit', 'Reddit') } };`);
const pubDone = report(p, 'Report: published', [4180, 900], 'publish', 'done', '{ url: $json.url, x: $json.x, reddit: $json.reddit, note: [$json.x, $json.reddit].filter(Boolean).join(" · ") || undefined }');
p.chain(pubStart, pubPost, pubReady, pubDate, pubBuild, pubSettings, pubPrep, xIf);
p.connect(xIf, x, 0);
p.chain(x, xSave, rIf);
p.connect(xIf, rIf, 1);
p.connect(rIf, reddit, 0);
p.chain(reddit, rSave, pubSum);
p.connect(rIf, pubSum, 1);
p.connect(pubSum, pubDone);

// ---- remove ----
p.note('remove', '### Remove from site\nThe post is no longer "published", so a rebuild drops it. Posts already on X / Reddit stay there.', [1060, 1080], [620, 110], 3);
const rmStart = report(p, 'Report: removing started', [1100, 1240], 'remove', 'start');
p.connect(route, rmStart, 2);
const rmBuild = http(p, 'Rebuild without the post', [1320, 1240], { method: 'POST', url: `=${WORKER}/build`, headers: [workerAuth], timeout: 600000 });
const rmDone = report(p, 'Report: removed', [1540, 1240], 'remove', 'done');
p.chain(rmStart, rmBuild, rmDone);

// =====================================================================
// Pipeline errors — runs when any node in "Post pipeline" fails
// =====================================================================

const e = workflow(ERRORS_ID, 'Pipeline errors');
e.note('about', '## Pipeline errors\nn8n runs this whenever **Post pipeline** fails, at any node. ' +
	'It finds the post by the run id the pipeline stored on it, and reports the **full** error: the post gets status *error*, ' +
	'the message, the failed step (so *Retry* continues from there), a progress-log line and a Telegram message with Retry buttons.', [-40, -280], [560, 200], 2);
const trig = e.node('When the pipeline fails', 'n8n-nodes-base.errorTrigger', 1, [0, 100], {});
const find = http(e, 'Find the post of this run', [220, 100], {
	url: `=${DIRECTUS}/items/posts?filter[run_id][_eq]={{ $json.execution.id }}&fields=id,current_stage&limit=1`,
});
const describeErr = code(e, 'Describe the error', [440, 100], `
const post = $input.first().json.data?.[0];
if (!post) return []; // the run failed before it was linked to a post
const ex = $('When the pipeline fails').item.json.execution;
const err = ex.error || {};
return [{ json: {
  postId: post.id,
  stage: post.current_stage || 'write',
  state: 'error',
  error: {
    node: ex.lastNodeExecuted || err.node?.name,
    message: err.message || 'Unknown error',
    description: err.description || (err.cause && JSON.stringify(err.cause)) || undefined,
    httpCode: err.httpCode,
    executionUrl: ex.url,
  },
} }];`, 'runOnceForAllItems');
const tell = http(e, 'Report the error', [660, 100], { method: 'POST', url: `=${WORKER}/stage`, headers: [workerAuth], body: '={{ JSON.stringify($json) }}' });
e.chain(trig, find, describeErr, tell);

// ---------- write ----------

const settings = { executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' };
const file = (w, extra = {}) => ({ id: w.id, name: w.name, nodes: w.nodes, connections: w.connections, active: false, settings: { ...settings, ...extra }, pinData: {}, meta: { templateCredsSetupCompleted: false } });

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(new URL('blog-pipeline.json', OUT), JSON.stringify(file(p, { errorWorkflow: ERRORS_ID }), null, 2) + '\n');
fs.writeFileSync(new URL('pipeline-errors.json', OUT), JSON.stringify(file(e), null, 2) + '\n');
console.log(`wrote ${p.nodes.length} + ${e.nodes.length} nodes`);
