#!/bin/bash
# Build the image on the instance from the deployed revision and run it hardened.
# /etc/ai-chess-arena.env (optional) may define PUBLIC_URL, PUBLIC_HOST and PUBLIC_IP.
# With PUBLIC_HOST set, Caddy terminates TLS (Let's Encrypt) in front of the app.
set -euo pipefail
cd /opt/ai-chess-arena
[ -f /etc/ai-chess-arena.env ] && source /etc/ai-chess-arena.env
docker network create chess-net 2>/dev/null || true
docker build -t ai-chess-arena:latest .
docker rm -f ai-chess-arena 2>/dev/null || true

if [ -n "${PUBLIC_HOST:-}" ]; then
  PORTS="-p 127.0.0.1:3000:3000"; TRUST="1"     # only Caddy can reach the app; trust its X-Forwarded-For
else
  PORTS="-p 80:3000 -p 3000:3000"; TRUST=""
fi

docker run -d --name ai-chess-arena --restart unless-stopped --network chess-net \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --memory 768m --pids-limit 200 $PORTS \
  -e DYNAMO_TABLE=ai-chess-arena-state \
  -e SECRETS_ID=ai-chess-arena/config \
  -e AWS_REGION=us-east-1 \
  -e PUBLIC_URL="${PUBLIC_URL:-}" \
  -e TRUST_PROXY="$TRUST" \
  ai-chess-arena:latest

if [ -n "${PUBLIC_HOST:-}" ]; then
  cat > /opt/Caddyfile <<CADDY
${PUBLIC_HOST} {
  reverse_proxy ai-chess-arena:3000
}
http://${PUBLIC_IP:-$PUBLIC_HOST} {
  reverse_proxy ai-chess-arena:3000
}
CADDY
  docker rm -f chess-caddy 2>/dev/null || true
  docker run -d --name chess-caddy --restart unless-stopped --network chess-net \
    --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \
    -p 80:80 -p 443:443 -v /opt/Caddyfile:/etc/caddy/Caddyfile:ro -v caddy_data:/data -v caddy_config:/config \
    caddy:2-alpine
fi
