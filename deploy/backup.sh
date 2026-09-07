#!/bin/sh
set -eu
cd "$(dirname "$0")"
umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p backups
# Stop writers so SQLite, images, queued CRDT messages and credentials share one snapshot.
docker compose stop receipt-app codex-provider
trap 'docker compose start codex-provider receipt-app >/dev/null' EXIT HUP INT TERM
tar -czf "backups/receipts-$stamp.tar.gz" compose.yml .env secrets data codex-data
sha256sum "backups/receipts-$stamp.tar.gz" > "backups/receipts-$stamp.tar.gz.sha256"
docker compose start codex-provider receipt-app
trap - EXIT HUP INT TERM
printf 'Backup: %s\n' "backups/receipts-$stamp.tar.gz"
