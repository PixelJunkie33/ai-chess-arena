#!/bin/bash
# Build the image on the instance from the deployed revision and run it hardened.
# /etc/ai-chess-arena.env (optional) may define PUBLIC_URL, PUBLIC_HOST and PUBLIC_IP.
# With PUBLIC_HOST set, Caddy terminates TLS (Let's Encrypt) in front of the app and writes a
# JSON access log of every site visit to /var/log/ai-chess-arena/access.log (rotated, 30 days).
set -euo pipefail
cd /opt/ai-chess-arena
[ -f /etc/ai-chess-arena.env ] && source /etc/ai-chess-arena.env
docker network create chess-net 2>/dev/null || true
mkdir -p /var/log/ai-chess-arena && chmod 755 /var/log/ai-chess-arena
LOGOPTS="--log-opt max-size=10m --log-opt max-file=3"    # cap Docker's own stdout logs
docker build -t ai-chess-arena:latest .
docker rm -f ai-chess-arena 2>/dev/null || true

if [ -n "${PUBLIC_HOST:-}" ]; then
  PORTS="-p 127.0.0.1:3000:3000"; TRUST="1"     # only Caddy can reach the app; trust its X-Forwarded-For
else
  PORTS="-p 80:3000 -p 3000:3000"; TRUST=""
fi

docker run -d --name ai-chess-arena --restart unless-stopped --network chess-net \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --memory 768m --pids-limit 200 $LOGOPTS $PORTS \
  -v /var/log/ai-chess-arena:/var/log/caddy:ro \
  -e ACCESS_LOG=/var/log/caddy/access.log \
  -e DYNAMO_TABLE=ai-chess-arena-state \
  -e SECRETS_ID=ai-chess-arena/config \
  -e AWS_REGION=us-east-1 \
  -e PUBLIC_URL="${PUBLIC_URL:-}" \
  -e TRUST_PROXY="$TRUST" \
  ai-chess-arena:latest

if [ -n "${PUBLIC_HOST:-}" ]; then
  cat > /opt/Caddyfile <<CADDY
(visits) {
  log {
    output file /var/log/caddy/access.log {
      mode 0644
      roll_size 50MiB
      roll_keep 5
      roll_keep_days 30
    }
    format json
  }
}
${PUBLIC_HOST} {
  import visits
  reverse_proxy ai-chess-arena:3000
}
http://${PUBLIC_IP:-$PUBLIC_HOST} {
  import visits
  reverse_proxy ai-chess-arena:3000
}
CADDY
  docker rm -f chess-caddy 2>/dev/null || true
  docker run -d --name chess-caddy --restart unless-stopped --network chess-net \
    --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges $LOGOPTS \
    -p 80:80 -p 443:443 \
    -v /opt/Caddyfile:/etc/caddy/Caddyfile:ro -v /var/log/ai-chess-arena:/var/log/caddy \
    -v caddy_data:/data -v caddy_config:/config \
    caddy:2-alpine
fi
