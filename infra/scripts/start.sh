#!/bin/bash
# Build the image on the instance from the deployed revision and run it hardened.
set -euo pipefail
cd /opt/ai-chess-arena
[ -f /etc/ai-chess-arena.env ] && source /etc/ai-chess-arena.env   # optional: PUBLIC_URL=http://<elastic-ip>
docker build -t ai-chess-arena:latest .
docker rm -f ai-chess-arena 2>/dev/null || true
docker run -d --name ai-chess-arena --restart unless-stopped \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --memory 768m --pids-limit 200 \
  -p 80:3000 -p 3000:3000 \
  -e DYNAMO_TABLE=ai-chess-arena-state \
  -e SECRETS_ID=ai-chess-arena/config \
  -e AWS_REGION=us-east-1 \
  -e PUBLIC_URL="${PUBLIC_URL:-}" \
  ai-chess-arena:latest
