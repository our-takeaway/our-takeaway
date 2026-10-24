#!/bin/sh
# First start only: import the workflows from this repo and publish them.
# After that, n8n's own database is the source of truth. To load newer versions
# from the repo later, see n8n/README.md ("Loading a newer version").
set -e
MARKER=/home/node/.n8n/.blog-workflow-imported
if [ ! -f "$MARKER" ]; then
  echo "Importing the workflows…"
  n8n import:workflow --separate --input=/bootstrap/workflows
  n8n publish:workflow --id=PipelineErrors01
  n8n publish:workflow --id=BlogPipeline0001
  touch "$MARKER"
fi
exec n8n start
