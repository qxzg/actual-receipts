import * as api from '@actual-app/api';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { transactionMatches } from './actual.js';
import type { ActualSettings } from './actual.js';
async function catalog(settings: ActualSettings) {
  const accounts = (await api.getAccounts()).filter(a => !a.closed && !a.offbudget).map(a => ({ id: a.id, name: a.name }));
  const categories = (await api.getCategories()).filter(c => !c.hidden && !c.is_income).map(c => ({ id: c.id, name: c.name, group: c.group_id }));
  return { accounts, categories, currency: settings.currency };
}
const parents = (rows: any[]) => rows.filter(r => !r.is_child && !r.parent_id);
function findTransaction(rows: any[], t: any) { return parents(rows).filter(r => r.id === t.id || r.imported_id === t.imported_id || r.notes?.includes(`[${t.imported_id}]`)); }
process.once('message', async ({ operation, payload, settings, dataDir }: any) => {
  let temporary: string | undefined;
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    // Verification downloads a clean copy: successful sync plus independent read-back is required.
    if (operation === 'verify') { temporary = await mkdtemp(join(dataDir, 'verify-')); dataDir = temporary; }
    await api.init({ dataDir, serverURL: settings.serverURL, password: settings.password });
    await api.downloadBudget(settings.syncId, settings.budgetPassword ? { password: settings.budgetPassword } : undefined);
    await api.sync();
    let result: any;
    if (operation === 'catalog' || operation === 'probe') result = await catalog(settings);
    else if (operation === 'duplicates') {
      const d = payload.draft; const center = new Date(d.date + 'T12:00:00Z').getTime();
      const start = new Date(center - 86400000).toISOString().slice(0, 10), end = new Date(center + 86400000).toISOString().slice(0, 10);
      const payees = await api.getPayees();
      result = parents(await api.getTransactions(d.account, start, end)).filter(r => r.amount === -d.total).map(r => ({ id: r.id, date: r.date, amount: r.amount, payee: payees.find(p => p.id === r.payee)?.name || '', notes: r.notes || '' }));
    } else if (operation === 'write' || operation === 'verify') {
      const t = payload.transaction;
      let matches = findTransaction(await api.getTransactions(t.account, '1900-01-01', '2200-12-31'), t);
      if (operation === 'write') {
        const c = await catalog(settings);
        if (!c.accounts.some(a => a.id === t.account) || t.subtransactions.some((s: any) => !c.categories.some(c => c.id === s.category))) throw new Error('catalog changed');
        if (!matches.length) { await api.addTransactions(t.account, [t], { learnCategories: false, runTransfers: false }); await api.sync(); matches = findTransaction(await api.getTransactions(t.account, '1900-01-01', '2200-12-31'), t); }
        if (matches.length !== 1 || !transactionMatches(matches[0], t)) throw new Error('readback mismatch');
        result = { id: matches[0].id };
      } else result = { found: matches.length > 0, valid: matches.length === 1 && transactionMatches(matches[0], t), id: matches[0]?.id };
    } else throw new Error('unsupported operation');
    await api.shutdown(); if (temporary) await rm(temporary, { recursive: true, force: true });
    process.send?.({ ok: true, result }, () => process.exit(0));
  } catch { await api.shutdown().catch(() => {}); if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {}); process.send?.({ ok: false }, () => process.exit(1)); }
});
