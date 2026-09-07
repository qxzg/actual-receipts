#!/bin/sh
set -eu
cd "$(dirname "$0")"
archive=${1:?Usage: ./restore-check.sh backups/receipts-TIMESTAMP.tar.gz}
umask 077
restore_dir=$(mktemp -d /tmp/receipts-restore-check.XXXXXX)
trap 'rm -rf "$restore_dir"' EXIT HUP INT TERM
tar -xzf "$archive" -C "$restore_dir"
chown -R 1000:1000 "$restore_dir"
docker run --rm --network none --read-only --user 1000:1000 --tmpfs /tmp \
  -e APP_ORIGIN=https://receipts.hx-sun.com -e DATA_DIR=/data \
  -e MASTER_KEY_FILE=/run/secrets/master-key -e PROVIDER_TOKEN_FILE=/run/secrets/provider-token \
  -v "$restore_dir/data:/data" -v "$restore_dir/secrets:/run/secrets:ro" \
  receipt-app:0.1.0 node --input-type=module -e '
import { Store } from "./dist/server/db.js";
import { loadConfig } from "./dist/server/config.js";
const c=loadConfig(), s=new Store(c.dataDir,c.key);
const settings=s.all("SELECT key FROM settings");
for(const row of settings) s.setting(row.key);
console.log(JSON.stringify({integrity:s.get("PRAGMA integrity_check"),settingsDecrypted:settings.length,owner:!!s.get("SELECT id FROM owner"),passkeys:s.get("SELECT count(*) AS count FROM passkeys")},null,2));
s.db.close();
'
