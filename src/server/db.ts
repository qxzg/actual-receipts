import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
export const now = () => Date.now();
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const id = () => randomUUID();
export class Store {
  db: DatabaseSync;
  constructor(public dir: string, private key: Buffer) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'receipts.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1), user_id TEXT UNIQUE NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY, public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL, verified_at INTEGER NOT NULL, created_at INTEGER NOT NULL, label TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, session_hash TEXT NOT NULL, kind TEXT NOT NULL, challenge TEXT NOT NULL, context TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS recovery(hash TEXT PRIMARY KEY, kind TEXT NOT NULL, expires INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_events(id INTEGER PRIMARY KEY, event TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, draft TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT, cleanup TEXT NOT NULL DEFAULT 'retained', transaction_id TEXT, submission_id TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS images(id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE, position INTEGER NOT NULL, path TEXT NOT NULL, thumbnail TEXT NOT NULL, UNIQUE(receipt_id,position));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE, version INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(receipt_id) WHERE status IN ('queued','running');
      CREATE TABLE IF NOT EXISTS submissions(id TEXT PRIMARY KEY, receipt_id TEXT UNIQUE NOT NULL REFERENCES receipts(id), version INTEGER NOT NULL, status TEXT NOT NULL, snapshot TEXT NOT NULL, allocation TEXT NOT NULL, transaction_id TEXT NOT NULL, connection TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cleanup_queue(receipt_id TEXT PRIMARY KEY REFERENCES receipts(id) ON DELETE CASCADE, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, remove_record INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO migrations VALUES(1, unixepoch()*1000);`);
  }
  get<T = any>(sql: string, ...args: any[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T = any>(sql: string, ...args: any[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }
  tx<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  encrypt(value: unknown) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', this.key, iv); const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]); return [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.'); }
  decrypt<T>(s: string): T { const [iv, tag, data] = s.split('.').map(b => Buffer.from(b, 'base64')); const c = createDecipheriv('aes-256-gcm', this.key, iv); c.setAuthTag(tag); return JSON.parse(Buffer.concat([c.update(data), c.final()]).toString()); }
  setting<T>(key: string): T | undefined { const row = this.get('SELECT value FROM settings WHERE key=?', key); return row ? this.decrypt<T>(row.value) : undefined; }
  setSetting(key: string, value: unknown) { this.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, this.encrypt(value)); }
  event(event: string) { this.run('INSERT INTO auth_events(event,at) VALUES(?,?)', event, now()); }
  consumeChallenge(sessionHash: string, challengeID: string, kind: string) {
    const c = this.get('DELETE FROM challenges WHERE id=? AND session_hash=? AND kind=? AND expires>? RETURNING *', challengeID, sessionHash, kind, now());
    if (!c) throw Object.assign(new Error('验证请求已过期，请重新验证'), { statusCode: 400 });
    return { ...c, context: JSON.parse(c.context) };
  }
  codes() {
    this.run("DELETE FROM recovery WHERE kind='code'");
    const codes = Array.from({ length: 10 }, () => randomBytes(15).toString('hex').match(/.{1,6}/g)!.join('-'));
    for (const c of codes) this.run("INSERT INTO recovery VALUES(?,'code',NULL,?)", hash(c), now());
    return codes;
  }
  adminToken(kind: 'bootstrap' | 'admin') {
    return this.tx(() => {
      if (kind === 'bootstrap' && this.get('SELECT id FROM owner')) throw new Error('所有者已创建');
      if (kind === 'admin' && !this.get('SELECT id FROM owner')) throw new Error('请先初始化所有者');
      this.run('DELETE FROM recovery WHERE kind=?', kind); const t = token();
      this.run('INSERT INTO recovery VALUES(?,?,?,?)', hash(t), kind, now() + 900_000, now()); this.event(`admin.${kind}.issued`); return t;
    });
  }
}
export function fail(message: string, statusCode = 400): never { throw Object.assign(new Error(message), { statusCode }); }
