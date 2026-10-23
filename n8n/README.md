# The workflow, node by node

There is one workflow: **Blog pipeline** ([workflows/blog-pipeline.json](workflows/blog-pipeline.json)). Directus calls it on every change to a post, and the post's **status** decides what happens. Each row below is a box in the n8n editor.

```
Directus: post changed → Read the event → Route by status ─┬─ Write    (new, revise)
                                                           ├─ Publish  (approved)
                                                           └─ Remove   (archived)
```

## Write: recording → transcript → AI draft

| Node | What it does |
|---|---|
| Mark as processing | status → `processing`, so you can see in Directus that something is happening |
| Get the post | reads the post (recording, Drive link, transcript, notes, feedback…) |
| Get writer settings | reads the prompt, model, transcription provider/language and key terms from **Writer Settings** in Directus |
| Transcribe the recording? | true when there is **no transcript** but there **is** an uploaded recording or a link |
| Mark as transcribing | status → `transcribing` |
| Transcribe the recording | `POST worker:4000/transcribe`: the worker downloads the upload or Drive link, keeps only the voice with ffmpeg, and sends it to ElevenLabs Scribe v2 (or Whisper). Returns text with `[mm:ss] Speaker n:` turns |
| Save the transcript | stores the text on the post, status → `processing` |
| Build the AI request | builds the OpenRouter request: system prompt + meeting material (+ current draft and feedback when revising) and the JSON schema of the answer |
| Ask the AI (OpenRouter) | `POST openrouter.ai/api/v1/chat/completions` |
| Check the AI answer | parses the JSON, makes sure both languages are there, cleans the slug and tags |
| Is the slug taken? / Use a free slug | adds the post number to the slug if another post already uses it |
| Save the draft | writes both languages and the social texts, status → `review` |
| Telegram set up? / Tell us on Telegram | optional message with a link to the draft |

## Publish: approved → live

| Node | What it does |
|---|---|
| Get the post to publish | reads the post |
| Mark as publishing | status → `publishing`, sets `published_at` the first time |
| Rebuild the site | `POST worker:4000/build`. The worker runs `astro build`, which pulls every `publishing`/`published` post from Directus, and swaps the live site atomically |
| Get social settings / Prepare social posts | builds the tweet (+ link) and the Reddit post from the post and Writer Settings |
| Post on X? → Post on X → Save the X link | only if "Post on X" is ticked, `X_ENABLED=true`, and there is no `x_url` yet (never posts twice) |
| Post on Reddit? → Post on Reddit → Save the Reddit link | same rules for Reddit |
| Mark as published | status → `published` |

## Remove

| Node | What it does |
|---|---|
| Rebuild without the post | status `archived` is not "published", so a rebuild drops the post from the site |

## Errors

Every risky step has a red error output wired to **Mark as error**. It sets status `error` and writes the message into the post's *Error message* field in Directus. Fix the cause, then set the status again (for example back to *New* or *Approved*) to retry.

## Why our own updates don't loop

n8n writes statuses back to Directus (`processing`, `transcribing`, `review`, `publishing`, `published`, `error`), and Directus sends each of those changes back here. *Route by status* only reacts to `new`, `revise`, `approved` and `archived`, which only a person sets, so those events simply end there.

## Changing the workflow

Edit it in the n8n editor; changes are live after you **Publish** it there. n8n's database is the source of truth after the first start. To save your version back into this repo:

```bash
docker compose exec n8n n8n export:workflow --id=BlogPipeline0001 --pretty --output=/tmp/blog-pipeline.json
```

```bash
docker compose cp n8n:/tmp/blog-pipeline.json n8n/workflows/blog-pipeline.json
```

Settings that are secrets or differ per server (Directus token, OpenRouter key, worker secret, site URL…) come from environment variables (`$env.…` in the nodes), set in `.env`.

### Loading a newer version from this repo onto the server

This **replaces** the workflow in n8n with the file from the repo, so save any edits you made in the n8n editor first (export above).

```bash
docker compose exec n8n n8n import:workflow --input=/bootstrap/workflows/blog-pipeline.json && docker compose exec n8n n8n publish:workflow --id=BlogPipeline0001 && docker compose restart n8n
```
