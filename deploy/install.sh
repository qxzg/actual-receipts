#!/bin/sh
set -eu
cd /opt/receipts
umask 077
python3 - <<'PY'
import json,hashlib,pathlib
root=pathlib.Path('images');m=json.loads((root/'manifest.json').read_text())
for name in ('receipt-app','codex-provider'):
    p=root/(name+'-0.1.0.tar.gz')
    assert hashlib.file_digest(open(p,'rb'),'sha256').hexdigest()==m[name]['archive_sha256'],name
print('Image archives verified')
PY
docker load -i images/receipt-app-0.1.0.tar.gz
docker load -i images/codex-provider-0.1.0.tar.gz
install -d -m 700 data codex-data secrets backups
if [ ! -f secrets/master-key ]; then openssl rand -hex 32 > secrets/master-key; fi
if [ ! -f secrets/provider-token ]; then openssl rand -hex 32 > secrets/provider-token; fi
chmod 400 secrets/master-key secrets/provider-token
chown -R 1000:1000 data codex-data secrets
if [ ! -f .env ]; then cp .env.example .env; fi
test -s /etc/ssl/certs/ca-certificates.crt
docker compose config -q
docker compose up -d --wait --wait-timeout 90
if ! grep -q '^receipts.hx-sun.com {' /opt/actual/Caddyfile; then
  cp /opt/actual/Caddyfile backups/Caddyfile.before-receipts
  cat /opt/actual/Caddyfile Caddyfile.receipts > /tmp/receipts-caddy-candidate
  docker exec -i actual-caddy caddy validate --config /dev/stdin --adapter caddyfile < /tmp/receipts-caddy-candidate
  cat /tmp/receipts-caddy-candidate > /opt/actual/Caddyfile
  if ! docker exec actual-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
    cat backups/Caddyfile.before-receipts > /opt/actual/Caddyfile
    docker exec actual-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
    exit 1
  fi
  rm /tmp/receipts-caddy-candidate
fi
docker compose ps
docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' receipts-receipt-app-1 receipts-codex-provider-1
