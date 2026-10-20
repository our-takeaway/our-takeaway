#!/bin/sh
# First start only: import the workflow from this repo and publish (activate) it.
# After that, n8n's own database is the source of truth — edit the workflow in
# the n8n editor, and export it back with:
#   docker compose exec n8n n8n export:workflow --id=BlogPipeline0001 --pretty --output=/tmp/w.json
set -e
MARKER=/home/node/.n8n/.blog-workflow-imported
if [ ! -f "$MARKER" ]; then
  echo "Importing the blog workflow…"
  n8n import:workflow --input=/bootstrap/workflows/blog-pipeline.json
  n8n publish:workflow --id=BlogPipeline0001
  touch "$MARKER"
fi
exec n8n start
