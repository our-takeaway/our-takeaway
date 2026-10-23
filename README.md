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

1. در Directus یک **Post** جدید می‌سازیم و یکی از این‌ها را می‌دهیم:
   - **فایل ضبط جلسه** در *Recording*، صوت یا ویدیو (تا ۵ گیگ). از ویدیو فقط صدایش استفاده می‌شود.
   - یا **لینک Google Drive** در *Or a Google Drive link*. فایل باید روی «Anyone with the link» به اشتراک گذاشته شده باشد. هر لینک مستقیم دیگری به فایل صوتی/ویدیویی هم کار می‌کند.
   - یا **متن آماده** در *Transcript*. در این حالت فایل و لینک استفاده نمی‌شوند.
2. اگر خواستید، در *Names and terms* اسم‌ها و اصطلاحاتی را که در جلسه گفته شده بنویسید تا درست نوشته شوند. بعد Save بزنید.
3. وضعیت پست خودکار جلو می‌رود: *Transcribing the recording…*، *AI is working…* و بعد *Ready for review*. حالا متن جلسه (با نام گوینده‌ها و زمان)، هر دو زبان، برچسب‌ها و متن توییت و Reddit آماده‌اند.
4. می‌خوانیم و ویرایش می‌کنیم. اگر بازنویسی لازم بود، در *Feedback* می‌نویسیم چه چیزی عوض شود و وضعیت را روی **Revise with AI** می‌گذاریم.
5. وضعیت را روی **Approved — publish now** می‌گذاریم. حدود ۲۰ ثانیه بعد پست روی سایت است و بعد در X و Reddit هم پست می‌شود.

- برای **ویرایش پستی که منتشر شده**: ویرایش کنید و دوباره *Approved* بزنید. سایت به‌روز می‌شود و X/Reddit دوباره پست نمی‌شوند.
- برای **برداشتن از سایت**: وضعیت را روی *Removed from site* بگذارید.
- اگر چیزی خطا داد، وضعیت *Error* می‌شود و پیامش در خود پست نوشته می‌شود. بعد از رفع مشکل، دوباره وضعیت را روی *New* بگذارید.

لحن و ساختار پست‌ها، مدل هوش مصنوعی، سرویس تبدیل صدا به متن و زبان متن شبکه‌های اجتماعی همه در **Writer Settings** داخل Directus قابل تغییرند، بدون دست زدن به کد.

## تبدیل صدا به متن

```
فایل آپلودشده یا لینک Drive → worker دانلود می‌کند → ffmpeg فقط صدا را نگه می‌دارد
→ ElevenLabs Scribe v2 → متن با «[زمان] Speaker n: …» → ادامهٔ workflow
```

- **ElevenLabs Scribe v2** پیش‌فرض است: روی فارسیِ قاطی با اصطلاحات انگلیسی از Whisper دقیق‌تر است، گوینده‌ها را جدا می‌کند و تا ۱۰ ساعت را در یک درخواست می‌پذیرد.
- ffmpeg از ویدیو فقط صدا را نگه می‌دارد (mono، Opus). یک ساعت ویدیوی حدود ۱ گیگی حدود ۱۵ مگ می‌شود و سریع آپلود می‌شود.
- **Whisper** (از طریق Groq) پشتیبان ارزان‌تر است. در Writer Settings → *Transcription provider* انتخابش کنید و `TRANSCRIBE_API_KEY` را در `.env` بگذارید.
- *Transcription language* را خالی بگذارید تا زبان خودکار تشخیص داده شود. برای فارسیِ قاطی با انگلیسی معمولاً همین بهتر است. اسم‌ها و اصطلاحاتی که همیشه تکرار می‌شوند را در Writer Settings → *Names and terms (every meeting)* بنویسید.
- فایل‌های Google Drive خصوصی پشتیبانی نمی‌شوند. فایل باید با لینک قابل دسترسی باشد.
- فایل‌های آپلودشده روی سرور می‌مانند. اگر جا کم شد، بعد از انتشار از Directus → File Library پاکشان کنید.

## هزینه‌ها

| بخش | هزینه برای یک جلسهٔ یک‌ساعته |
|---|---|
| تبدیل صدا به متن با ElevenLabs Scribe v2 | حدود ۰٫۲۲ دلار |
| همان با Whisper روی Groq (پشتیبان) | حدود ۰٫۱۱ دلار |
| چسباندن متن آماده | رایگان |
| نوشتن پست دوزبانه با OpenRouter و `deepseek/deepseek-v4-flash-0731` | کمتر از یک سنت |
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

## Telegram (اختیاری)
اگر `TELEGRAM_BOT_TOKEN` و `TELEGRAM_CHAT_ID` را بگذارید، وقتی پیش‌نویس آماده شد پیامی با لینک مستقیم به پست در Directus می‌گیرید.

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
