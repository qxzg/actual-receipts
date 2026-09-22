import { formatItemNotes, formatLegacyNotes } from '../shared/product.js';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import { Store, fail, hash } from './db.js';
import type { Draft, Allocation, Account, Category } from '../shared/receipt.js';
export const actualSettingsSchema = z.object({ serverURL: z.url().max(500), password: z.string().max(2000), syncId: z.string().min(1).max(200), budgetPassword: z.string().max(2000).default(''), currency: z.enum(['USD', 'CNY', 'EUR', 'GBP', 'CAD', 'AUD', 'HKD', 'SGD']), testBudget: z.boolean() });
export type ActualSettings = z.infer<typeof actualSettingsSchema>;
export type Catalog = { accounts: Account[]; categories: Category[]; currency: string; defaultAccount?: string };
export type Candidate = { id: string; date: string; amount: number; payee: string; notes: string };
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> { const next = this.tail.then(fn); this.tail = next.catch(() => {}); return next; }
}
export const markerFor = (submissionID: string) => `receipt:${submissionID}`;
export function buildTransaction(d: Draft, allocation: Allocation, submissionID: string, parentID: string, notesFormatVersion = 2) {
  const marker = markerFor(submissionID);
  return { id: parentID, account: d.account, date: d.date, amount: -d.total, payee_name: d.merchant,
    imported_id: marker, notes: `[${marker}] ${d.merchant}`, is_parent: true, cleared: false,
    subtransactions: d.items.map((i, n) => ({ account: d.account, date: d.date, parent_id: parentID, is_child: true, is_parent: false,
      amount: -allocation.lines[n].final, category: i.category!, cleared: false,
      notes: notesFormatVersion === 1 ? formatLegacyNotes(i, allocation.lines[n], d.currency) : formatItemNotes(i, d.currency),
    })) };
}
export function transactionMatches(found: any, wanted: ReturnType<typeof buildTransaction>) {
  if (!found || found.account !== wanted.account || found.amount !== wanted.amount || found.date !== wanted.date || found.notes !== wanted.notes || !found.is_parent) return false;
  const children = [...(found.subtransactions || [])];
  return children.length === wanted.subtransactions.length && wanted.subtransactions.every(w => {
    const ix = children.findIndex(c => c.amount === w.amount && c.category === w.category && c.notes === w.notes && c.account === w.account && c.date === w.date);
    if (ix < 0) return false; children.splice(ix, 1); return true;
  });
}
export class ActualBridge {
  private queue = new Serial();
  constructor(private store: Store) {}
  settings() { const settings = this.store.setting<ActualSettings>('actual'); if (!settings) fail('请在设置中连接 Actual', 422); return settings; }
  connection(settings = this.settings()) { return hash(JSON.stringify([settings.serverURL, settings.syncId])); }
  call<T>(operation: string, payload: any = {}, override?: ActualSettings): Promise<T> {
    const settings = override || this.settings();
    return this.queue.run(() => new Promise<T>((resolve, reject) => {
      const js = fileURLToPath(new URL('./actual-worker.js', import.meta.url));
      const worker = fork(js, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH, NODE_ENV: 'production' }, execArgv: ['--max-old-space-size=300'] });
      let settled = false;
      const finish = (error?: Error, value?: T) => { if (settled) return; settled = true; clearTimeout(timer); worker.kill('SIGKILL'); error ? reject(error) : resolve(value!); };
      const timer = setTimeout(() => finish(new Error('Actual 同步超时；提交结果将进入核验流程')), 120_000);
      worker.on('message', (message: any) => message.ok ? finish(undefined, message.result) : finish(new Error('Actual 连接或数据校验失败，请检查连接设置和账本状态')));
      worker.on('error', () => finish(new Error('Actual 同步进程启动失败')));
      worker.on('exit', () => finish(new Error('Actual 同步进程中断；请核验提交状态')));
      worker.send({ operation, payload, settings, dataDir: join(this.store.dir, 'actual-cache', this.connection(settings)) });
    }));
  }
  catalog() { return this.call<Catalog>('catalog'); }
  duplicates(draft: Draft) { return this.call<Candidate[]>('duplicates', { draft }); }
  write(transaction: ReturnType<typeof buildTransaction>) { return this.call<{ id: string }>('write', { transaction }); }
  verify(transaction: ReturnType<typeof buildTransaction>) { return this.call<{ found: boolean; valid: boolean; id?: string }>('verify', { transaction }); }
}
