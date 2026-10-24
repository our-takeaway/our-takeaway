# Build context is the repo root (see docker-compose.yml) so the site can be copied in.
FROM node:24-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ffmpeg ca-certificates curl unzip poppler-utils \
	&& rm -rf /var/lib/apt/lists/*

ENV ASTRO_TELEMETRY_DISABLED=1 NODE_ENV=production

# The Astro site — rebuilt by the worker whenever n8n asks
WORKDIR /app/site
COPY site/package.json site/package-lock.json ./
RUN npm ci --include=dev
COPY site/ ./

WORKDIR /app/worker
COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev
COPY worker/ ./

ENV SITE_DIR=/app/site WWW_DIR=/www PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost:4000/healthz || exit 1
CMD ["node", "src/server.js"]
