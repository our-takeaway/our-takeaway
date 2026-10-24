# The workflows, node by node

Two workflows, both generated from [build-workflows.mjs](build-workflows.mjs):

- **Post pipeline** ([workflows/blog-pipeline.json](workflows/blog-pipeline.json)): Directus calls it on every change to a post; the post's **status** decides what runs.
- **Pipeline errors** ([workflows/pipeline-errors.json](workflows/pipeline-errors.json)): n8n runs it whenever *any* node of the pipeline fails.

```
Directus: post changed → Decide what to run → Get the post → Where to start → Claim this run → Route
   Generate:  [1 Transcription] → [2 Writing, meeting language] → [3 Translation, other language] → review
   Publish:   rebuild site → X → Reddit → published
   Remove:    rebuild site without the post
```

## Where a run starts

| Status (set by you, in the CMS or with a Telegram button) | Starts at |
|---|---|
| `new` | Transcription (skipped if the post already has a transcript) |
| `revise` | Writing, with the current draft and your Feedback |
| `retry` | the step in **Restart from**, or else the step that failed (`error_stage`) |
| `approved` | Publishing |
| `archived` | Removing from site |

Every other status (`transcribing`, `writing`, `translating`, `review`, `publishing`, `published`, `error`) is written by the automation and ignored here, so runs never loop.

**Claim this run** stores the n8n execution id on the post (`run_id`). That is how *Pipeline errors* finds the post when something fails.

## The steps

Each step starts and ends with a **Report: …** node. It calls the worker (`POST /stage`), which:
- sets the post's status and *Current / last step*
- adds a line to the post's *Progress log*
- sends the Telegram message: the transcript and the drafts as files, the review buttons, the published link

### 1 · Transcription
| Node | What it does |
|---|---|
| Transcribe? | runs only when starting here and there is no transcript yet (or you chose *Restart from: Transcription*, which redoes it) |
| Transcribe (worker) | `POST worker/transcribe {postId}`. The worker uses, in this order: the **transcript file** (txt, md, srt, vtt, docx, pdf), the **uploaded recording**, the **Drive / direct link**. Recordings are reduced to the voice with ffmpeg and sent to the post's speech-to-text model (or the Writer Settings default). Returns the text, detected language, model and duration. |
| Save the transcript | stores the transcript and the detected language |

### 2 · Writing (in the meeting's language)
| Node | What it does |
|---|---|
| Write? | skipped when you restart from Translation |
| Get the post / Get writer settings (writing) | fresh copies of both |
| Build the writing request | language = *Language of the meeting* → detected language → guessed from the text. Model = the post's *AI model* → Writer Settings default. Sends the **Writing prompt**, the meeting notes and the transcript, plus the current draft and Feedback when revising. Asks for JSON: slug, title, description, tags, body. |
| Ask the AI to write | `POST openrouter.ai/api/v1/chat/completions` with `max_tokens` and `reasoning.effort` from Writer Settings |
| Check the draft | parses the answer. If the model ran out of output space, fails with a message saying what to change |
| Is the slug taken? / Use a free slug | adds the post number if another post already uses the slug |
| Save the draft | that language's title, description, tags and body |

### 3 · Translation
| Node | What it does |
|---|---|
| Build the translation request | the finished draft → the other language, with the **Translation prompt**. Also asks for the tweet and the Reddit title/text in the social language. |
| Ask the AI to translate / Check the translation / Save the translation | same pattern as writing |
| Report: translation done (→ review) | status → `review`; Telegram gets both drafts as `.md` files and the review buttons |

### Publish
Get the post → **Ready to publish?** (slug and at least one language) → set the publish date → **Rebuild the site** (`POST worker/build`) → X → Reddit → **Sum up the social posts** → status `published`. X and Reddit are tried once each (a saved link means already posted). A failure there is reported in the progress log and in Telegram, but does not undo the publish.

### Remove
Rebuild the site; the post is no longer "published", so it disappears. Posts on X / Reddit stay.

## Errors

The pipeline has no error branches of its own. When any node fails, n8n runs **Pipeline errors**:

When the pipeline fails → **Find the post of this run** (by `run_id`) → **Describe the error** → **Report the error**.

The post gets:
- status `error`
- the step in *error_stage*, so **Retry** continues from there
- the **full** error: step, node, message, the API's own response, HTTP status and a link to the n8n execution
- a line in the progress log

Telegram gets the same text, with **Retry this step / Start over / Change model** buttons.

## Changing the workflows

The JSON files are generated: edit [build-workflows.mjs](build-workflows.mjs), then run `node n8n/build-workflows.mjs`. You can also edit in the n8n editor and publish there; then export your version so the repo doesn't fall behind:

```bash
docker compose exec n8n n8n export:workflow --id=BlogPipeline0001 --pretty --output=/tmp/blog-pipeline.json
```

```bash
docker compose cp n8n:/tmp/blog-pipeline.json n8n/workflows/blog-pipeline.json
```

Secrets and per-server settings (Directus token, OpenRouter key, worker secret, site URL…) come from environment variables (`$env.…` in the nodes), set in `.env`.

### Loading a newer version from this repo onto the server

This **replaces** both workflows in n8n with the files from the repo, so save any edits you made in the n8n editor first (export above).

```bash
docker compose exec n8n n8n import:workflow --separate --input=/bootstrap/workflows && docker compose exec n8n n8n publish:workflow --id=PipelineErrors01 && docker compose exec n8n n8n publish:workflow --id=BlogPipeline0001 && docker compose restart n8n
```
