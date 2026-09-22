import { mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from './db.js';
import { loadConfig } from './config.js';
import { ActualBridge } from './actual.js';
import { ReceiptService } from './service.js';
const config = loadConfig(), store = new Store(config.dataDir, config.key);
const service = new ReceiptService(store, new ActualBridge(store), undefined as any, config.key);
const command = process.argv[2];
try {
  if (command === 'bootstrap' || command === 'recover') {
    const value = store.adminToken(command === 'bootstrap' ? 'bootstrap' : 'admin');
    console.log(`15 分钟内在 ${config.origin} 输入以下一次性${command === 'bootstrap' ? '初始化令牌' : '恢复令牌'}：\n${value}`);
  } else if (command === 'check') {
    console.log(JSON.stringify({ integrity: store.get('PRAGMA integrity_check'), owner: !!store.get('SELECT id FROM owner'), passkeys: store.get('SELECT count(*) AS count FROM passkeys'), receipts: store.get('SELECT count(*) AS count FROM receipts'), pending: store.get("SELECT count(*) AS count FROM submissions WHERE status!='synced'"), cleanupQueued: store.get('SELECT count(*) AS count FROM cleanup_queue'), otherLedgerReceipts: store.setting('actual') ? service.otherLedgerReceiptCount() : 0 }, null, 2));
  } else if (command === 'purge-old-ledgers') {
    if (process.argv[3] !== '--confirm') throw new Error('永久清理其他账本记录需要 --confirm');
    console.log(JSON.stringify(service.purgeOtherLedgers(), null, 2));
  } else if (command === 'snapshot') {
    const dest = resolve(process.argv[3] || 'backups/snapshot'); mkdirSync(dest, { recursive: true, mode: 0o700 });
    store.db.prepare('VACUUM INTO ?').run(join(dest, 'receipts.sqlite'));
    copyFileSync(process.env.MASTER_KEY_FILE || 'secrets/master-key', join(dest, 'master-key'));
    console.log(`数据库快照已保存到 ${dest}。完整备份应同时保留图片、Actual 缓存、Codex 凭据和 Secret。`);
  } else throw new Error('用法：admin bootstrap | recover | check | snapshot <目录> | purge-old-ledgers --confirm');
} finally { store.db.close(); }
