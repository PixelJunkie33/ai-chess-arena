#!/bin/bash
# Build the image on the instance from the deployed revision and run it next to a Redis container.
set -euo pipefail
cd /opt/ai-chess-arena
docker network create chess-net 2>/dev/null || true
docker start chess-redis 2>/dev/null || docker run -d --name chess-redis --restart unless-stopped --network chess-net redis:7-alpine
docker build -t ai-chess-arena:latest .
docker rm -f ai-chess-arena 2>/dev/null || true
docker run -d --name ai-chess-arena --restart unless-stopped --network chess-net -p 3000:3000 \
  -e REDIS_URL=redis://chess-redis:6379 \
  -e DYNAMO_TABLE=ai-chess-arena-matches \
  -e AWS_REGION=us-east-1 \
  ai-chess-arena:latest
