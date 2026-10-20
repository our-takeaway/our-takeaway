# The workflow, node by node

There is one workflow: **Blog pipeline** ([workflows/blog-pipeline.json](workflows/blog-pipeline.json)). Directus calls it on every change to a post, and the post's **status** decides what happens. Each row below is a box in the n8n editor.

```
Directus: post changed → Read the event → Route by status ─┬─ Write    (new, revise)
                                                           ├─ Publish  (approved)
                                                           └─ Remove   (archived)
```

## Write: transcript → AI draft

| Node | What it does |
|---|---|
| Mark as processing | status → `processing`, so you can see in Directus that the AI is working |
| Get the post | reads the post (transcript, notes, feedback…) |
| Transcribe audio first? | only true when there is **no transcript**, there **is** an audio file, and "Transcribe the audio" is ticked |
| Whisper (optional, paid) | asks the worker to transcribe the audio (`POST worker:4000/transcribe`) |
| Save the transcript | stores the Whisper text on the post |
| Get writer settings | reads the prompt, model and social language from **Writer Settings** in Directus |
| Build the AI request | builds the OpenRouter request: system prompt + meeting material (+ current draft and feedback when revising) and the JSON schema of the answer |
| Ask the AI (OpenRouter) | `POST openrouter.ai/api/v1/chat/completions` |
| Check the AI answer | parses the JSON, makes sure both languages are there, cleans the slug and tags |
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

n8n writes statuses back to Directus (`processing`, `review`, `publishing`, `published`, `error`), and Directus sends each of those changes back here. *Route by status* only reacts to `new`, `revise`, `approved` and `archived`, which only a person sets, so those events simply end there.

## Changing the workflow

Edit it in the n8n editor; changes are live after you **Publish** it there. n8n's database is the source of truth after the first start. To save your version back into this repo:

```bash
docker compose exec n8n n8n export:workflow --id=BlogPipeline0001 --pretty --output=/tmp/blog-pipeline.json
```

```bash
docker compose cp n8n:/tmp/blog-pipeline.json n8n/workflows/blog-pipeline.json
```

Settings that are secrets or differ per server (Directus token, OpenRouter key, worker secret, site URL…) come from environment variables (`$env.…` in the nodes), set in `.env`.
