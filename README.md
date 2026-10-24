# برداشت ما (Our Takeaway)

متن جلسه ← پیش‌نویس دوزبانه با هوش مصنوعی ← **تأیید ما در CMS** ← سایت + X + Reddit

```
 ترنسکریپت (رایگان، با ابزار خودمان)          ┌──────────── VPS (Docker) ────────────────────────────┐
 یا فایل صوتی + تیک Whisper (اختیاری) ──────▶│ Directus (CMS + Postgres)                            │
                                             │   │  هر تغییر در یک پست                                │
                                             │   ▼                                                  │
                                             │ n8n: workflow «Blog pipeline»                        │
                                             │   ├─ new/revise  → OpenRouter → پیش‌نویس fa+en → review │
                                             │   ├─ approved    → worker: build سایت → X → Reddit     │
                                             │   └─ archived    → worker: build بدون آن پست            │
                                             │                                                      │
                                             │ worker: astro build (پست‌ها را از Directus می‌خواند)    │
                                             │ Caddy: سایت استاتیک + HTTPS                            │
                                             └──────────────────────────────────────────────────────┘
```

| پوشه | چیست |
|---|---|
| `site/` | وبلاگ Astro، فارسی و انگلیسی با دکمهٔ تغییر زبان. پست‌ها را موقع build از Directus می‌گیرد. |
| `directus/` | اسکریپت راه‌اندازی CMS (collectionها، تنظیمات، Flow) و prompt پیش‌فرض |
| `n8n/` | workflow کامل به‌صورت JSON و [توضیح نود به نود](n8n/README.md) |
| `worker/` | سرویس کوچکی برای کارهایی که n8n خودش نمی‌کند: build سایت و Whisper |
| `docker-compose.yml`, `Caddyfile` | اجرای همه چیز روی سرور |

## روند کار برای ما

```
ضبط جلسه / فایل متن / لینک Drive
  → ۱ · تبدیل به متن      (ElevenLabs یا Whisper)
  → ۲ · نوشتن پست         (به زبان خود جلسه)
  → ۳ · ترجمه             (به زبان دیگر + متن X و Reddit)
  → بازبینی ما            (در CMS یا تلگرام)
  → انتشار                (سایت + X + Reddit)
```

1. در Directus یک **Post** جدید می‌سازیم و یکی از این‌ها را می‌دهیم:
   - **فایل ضبط جلسه** در *Recording*، صوت یا ویدیو تا ۵ گیگ. از ویدیو فقط صدایش استفاده می‌شود.
   - یا **لینک Google Drive**. فایل باید «Anyone with the link» باشد. لینک مستقیم دیگر هم کار می‌کند.
   - یا **فایل متن جلسه** در *Or a transcript file*: ‏txt، md، srt، vtt، docx یا pdf. برای متن‌های طولانی بهترین راه است.
   - یا **متن آماده** در *Transcript*.
   - یا همهٔ این‌ها را **به ربات تلگرام بفرستید** (بخش تلگرام را ببینید).
2. اگر خواستید: زبان جلسه در *Language of the meeting* (خالی = تشخیص خودکار)، اسم‌ها و اصطلاحات در *Names and terms*، و مدل‌ها در بخش **0 · Progress and models**. بعد Save بزنید.
3. پست خودش جلو می‌رود: *Transcribing…*، *AI is writing…*، *Translating…*، و بعد *Ready for review*.
   - پست **به زبان خود جلسه** نوشته می‌شود و بعد **به زبان دیگر ترجمه** می‌شود. جلسهٔ فارسی نسخهٔ انگلیسی هم می‌گیرد، و برعکس.
   - هر قدم در *Progress log* خود پست و در تلگرام ثبت می‌شود.
4. می‌خوانیم و ویرایش می‌کنیم: مستقیم در CMS، یا با فرستادن فایل ویرایش‌شده در تلگرام. برای بازنویسی با AI، در *Feedback* بنویسید چه چیزی عوض شود و وضعیت را **Revise with AI** بگذارید، یا در تلگرام به پیام پست جواب بدهید.
5. وضعیت را **Approved — publish now** بگذارید، یا در تلگرام ✅ Publish را بزنید.

### وقتی خطا پیش می‌آید

- وضعیت پست **Error** می‌شود. **متن کامل خطا** بالای پست نمایش داده می‌شود: کدام قدم، کدام نود n8n، پیام، جواب کامل خود API و لینک اجرای n8n. همین متن به تلگرام هم می‌رود.
- علت را برطرف کنید. مثلاً لینک را درست کنید، یا در *AI model (this post)* مدل دیگری انتخاب کنید.
- بعد وضعیت را **Retry** بگذارید، یا در تلگرام 🔁 Retry this step را بزنید. کار **از همان قدمی که خطا داده** ادامه پیدا می‌کند، نه از اول.
- برای شروع از قدم دیگری، *Restart from* را انتخاب کنید و بعد Retry بزنید:
  - **Transcription**: دوباره تبدیل به متن، مثلاً با مدل دیگر.
  - **Writing**: نوشتن دوباره.
  - **Translation**: فقط ترجمهٔ دوباره.
  - **Publishing**: انتشار دوباره.

### انتخاب مدل

- پیش‌فرض‌ها در **Writer Settings** هستند:
  - مدل AI برای نوشتن و ترجمه (هر مدل OpenRouter).
  - *Reasoning effort* و *Max output tokens*.
  - مدل تبدیل صدا به متن.
- هر پست می‌تواند در بخش **0 · Progress and models** مدل خودش را داشته باشد. در تلگرام هم دکمهٔ 🤖 Change model همین کار را می‌کند.
- اگر متن طولانی بود و خطای «ran out of output space» گرفتید:
  - مدلی با خروجی بزرگ‌تر انتخاب کنید، مثلاً `deepseek/deepseek-v4.1-flash` یا `deepseek/deepseek-v4-pro`.
  - یا *Reasoning effort* را Low کنید.
  - یا *Max output tokens* را بالاتر ببرید.
  - بعد Retry بزنید.
- مدل‌هایی که در تلگرام نشان داده می‌شوند در Writer Settings → *AI models offered in Telegram* و *Speech-to-text models offered in Telegram* قابل تغییرند.

## تلگرام

اگر `TELEGRAM_BOT_TOKEN` و `TELEGRAM_CHAT_ID` در `.env` باشند، ربات این کارها را می‌کند:

- **برای هر قدم پیام می‌دهد:** شروع و پایان تبدیل به متن (همراه فایل متن جلسه)، نوشتن، ترجمه، انتشار، و هر خطا با متن کامل.
- **وقتی پیش‌نویس آماده شد** هر دو زبان را به‌صورت فایل `post-<id>.fa.md` و `post-<id>.en.md` می‌فرستد، با این دکمه‌ها: ✅ Publish، ✏️ Revise، 🔁 Rewrite، 🌐 Re-translate، 🤖 Change model، 🔗 Open in CMS.
- **ویرایش در تلگرام:**
  - فایل `.md` را باز کنید، ویرایش کنید و در جواب همان فایل بفرستید (اسم فایل را عوض نکنید). عنوان، توضیح، برچسب‌ها و متن آن زبان جایگزین می‌شود.
  - برای بازنویسی با AI، به هر پیامِ آن پست با متن جواب بدهید. جوابتان Feedback می‌شود و پست بازنویسی می‌شود.
- **روی پیام خطا:** 🔁 Retry this step، 🔄 Start over، 🤖 Change model.
- **شروع پست جدید از تلگرام:** یک ضبط صدا یا ویدیو (تا ۲۰ مگ، محدودیت خود تلگرام برای ربات‌ها)، یک فایل متن جلسه، یا یک لینک Drive بفرستید. caption یا متن کنار لینک عنوان پست می‌شود.
- **دسترسی:** فقط چت‌هایی که در `TELEGRAM_CHAT_ID` هستند می‌توانند از ربات استفاده کنند. چند id را با کاما جدا کنید، مثلاً گروه خودتان. اگر در یک چت دیگر `/start` بزنید، ربات id آن چت را می‌گوید.
- ربات webhook خودش را موقع شروع worker تنظیم می‌کند، روی `https://<CMS_DOMAIN>/telegram/webhook`.

## تبدیل صدا به متن

```
فایل آپلودشده یا لینک Drive → worker دانلود می‌کند → ffmpeg فقط صدا را نگه می‌دارد
→ ElevenLabs Scribe v2 (یا Whisper) → متن با «[زمان] Speaker n: …» → ادامهٔ workflow
```

- **ElevenLabs Scribe v2** پیش‌فرض است: روی فارسیِ قاطی با اصطلاحات انگلیسی از Whisper دقیق‌تر است، گوینده‌ها را جدا می‌کند و تا ۱۰ ساعت را در یک درخواست می‌پذیرد. زبان تشخیص‌داده‌شده ذخیره می‌شود و تعیین می‌کند پست اول به کدام زبان نوشته شود.
- ffmpeg از ویدیو فقط صدا را نگه می‌دارد (mono، Opus). یک ساعت ویدیوی حدود ۱ گیگی حدود ۱۵ مگ می‌شود و سریع آپلود می‌شود.
- **Whisper** (از طریق Groq، مدل `whisper:whisper-large-v3` یا `whisper:whisper-large-v3-turbo`) پشتیبان ارزان‌تر است و `TRANSCRIBE_API_KEY` را در `.env` لازم دارد.
- اسم‌ها و اصطلاحاتی که همیشه تکرار می‌شوند را در Writer Settings → *Names and terms (every meeting)* بنویسید.
- فایل‌های Google Drive خصوصی پشتیبانی نمی‌شوند. فایل باید با لینک قابل دسترسی باشد.
- فایل‌های آپلودشده روی سرور می‌مانند. اگر جا کم شد، بعد از انتشار از Directus → File Library پاکشان کنید.

## هزینه‌ها

| بخش | هزینه برای یک جلسهٔ یک‌ساعته |
|---|---|
| تبدیل صدا به متن با ElevenLabs Scribe v2 | حدود ۰٫۲۲ دلار |
| همان با Whisper روی Groq (پشتیبان) | حدود ۰٫۱۱ دلار |
| چسباندن متن آماده | رایگان |
| نوشتن و ترجمه با OpenRouter و `deepseek/deepseek-v4-flash-0731` | کمتر از یک سنت |
| اگر بعداً مدل قوی‌تری بخواهید، مثلاً `anthropic/claude-sonnet-5.5` | حدود ۰٫۲ تا ۰٫۴ دلار |
| Directus، n8n، Postgres، Caddy | رایگان (self-hosted) |

مدل را هر وقت خواستید در Writer Settings عوض کنید. فهرست مدل‌ها در openrouter.ai/models است.

## راه‌اندازی روی VPS

### ۱. DNS
سه رکورد `A` بسازید که همه به IP سرور اشاره کنند:

| آدرس | چیست |
|---|---|
| `blog.sajadsarlaki.com` | سایت عمومی |
| `cms.sajadsarlaki.com` | Directus، جایی که پست‌ها را بازبینی می‌کنیم |
| `n8n.sajadsarlaki.com` | ویرایشگر workflow |

### ۲. Swap
سرور ۴ گیگ RAM دارد و swap ندارد. Postgres، Directus، n8n و build سایت روی هم حدود ۱٫۵ گیگ می‌شوند، به‌علاوهٔ `rag-service` که الان روی سرور است:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### ۳. تنظیمات

```bash
git clone <this-repo> /root/meeting-blog && cd /root/meeting-blog && cp .env.example .env
```

در `.env` دامنه‌ها، ایمیل و رمز Directus، کلید OpenRouter، کلید ElevenLabs و شش مقدار تصادفی را پر کنید. هر مقدار تصادفی را با این دستور بسازید:

```bash
openssl rand -hex 32
```

### ۴. اجرا

```bash
docker compose up -d --build
```

```bash
docker compose logs -f directus-setup n8n worker
```

بار اول سرویس `directus-setup` جدول‌ها، تنظیمات، prompt و Flow را می‌سازد. n8n هم workflow را import و فعال می‌کند. Caddy گواهی HTTPS را خودکار می‌گیرد.

### ۵. بلافاصله بعد از اجرا

1. **`https://n8n.…` را باز کنید و حساب owner را بسازید.** تا این کار را نکنید، هر کسی که آدرس را باز کند می‌تواند owner شود.
2. **`https://cms.…`** را با ایمیل و رمز `.env` باز کنید. Directus 12 در اولین ورود دو سؤال می‌پرسد:
   - لایسنس: «I'm using Core plan» را انتخاب کنید (رایگان).
   - project owner: ایمیل خودتان را بدهید و شرایط لایسنس Directus (MSCL-1.0-GPL) را بخوانید و قبول کنید.
3. در **Writer Settings** مدل و prompt را ببینید و اگر خواستید تغییر دهید.

## X و Reddit (اختیاری)

اتصال این دو در خود n8n انجام می‌شود:

1. **X:** در developer.x.com یک App با OAuth 2.0 و دسترسی Read and write بسازید. Callback URL را این بگذارید:
   ```
   https://n8n.sajadsarlaki.com/rest/oauth2-credential/callback
   ```
   در n8n نود **Post on X** را باز کنید، credential جدید «X OAuth2 API» بسازید و Connect بزنید.
2. **Reddit:** در reddit.com/prefs/apps یک اپ از نوع **web app** با همان Callback URL بسازید. Reddit برای اپ‌های API جدید درخواست تأیید می‌خواهد. در n8n نود **Post on Reddit** را باز کنید و credential «Reddit OAuth2 API» بسازید.
3. در Writer Settings فیلد `reddit_subreddit` را پر کنید. `u_<username>` روی پروفایل خودتان پست می‌گذارد و امن‌ترین شروع است.
4. در `.env` مقدار `X_ENABLED=true` و/یا `REDDIT_ENABLED=true` را بگذارید، بعد:
   ```bash
   docker compose up -d n8n
   ```

## زبان سایت
- آدرس‌ها `/fa/...` و `/en/...` هستند و دکمهٔ بالای صفحه همان پست را به زبان دیگر باز می‌کند.
- انتخاب خواننده در یک cookie ذخیره می‌شود. کسی که اولین بار `/` را باز کند، بر اساس زبان مرورگرش به فارسی یا انگلیسی می‌رود.
- تشخیص زبان از روی لوکیشن (Geo-IP) پیاده نشده: به یک دیتابیس IP نیاز دارد و زبان مرورگر معمولاً دقیق‌تر است. اگر بعداً لازم شد، در Caddy قابل اضافه کردن است.

## توسعه و تغییر

- **workflow:** در n8n ویرایش کنید و Publish بزنید. روش برگرداندن تغییرات به repo در [n8n/README.md](n8n/README.md) است.
- **فیلدهای CMS:** در Directus از Settings → Data Model اضافه کنید، یا در `directus/setup.mjs` تعریف کنید تا روی نصب‌های تازه هم ساخته شوند.
- **دیزاین سایت:** `site/src/`، متن‌های ثابت در `site/src/consts.ts` و `site/src/lib/i18n.ts`. بعد از تغییر:
  ```bash
  docker compose up -d --build worker
  ```

### اجرای سایت به‌تنهایی روی لپ‌تاپ
بدون `DIRECTUS_URL`، سایت پست‌های نمونهٔ `site/src/content/sample/` را نشان می‌دهد:

```bash
cd site && npm install && npm run dev
```
