import { z } from 'zod';
import { productSchema, needsProductReview } from './product.js';
export const money = z.number().int().min(0).max(1_000_000_000);
export const currencies = ['USD', 'CNY', 'EUR', 'GBP', 'CAD', 'AUD', 'HKD', 'SGD'] as const;
export const itemSchema = z.object({
  id: z.string().min(1).max(80), name: z.string().max(300),
  product: productSchema.nullable().optional(),
  quantity: z.string().regex(/^\d{1,8}(\.\d{1,6})?$/), unitPrice: money.nullable(),
  amount: money, discount: money, category: z.string().max(100).nullable(),
});
export const adjustmentSchema = z.object({
  id: z.string().min(1).max(80), kind: z.enum(['discount', 'tax', 'tip', 'fee']),
  label: z.string().max(100), amount: money,
  scope: z.union([z.literal('all'), z.array(z.string().max(80)).max(300), z.null()]),
  confirmed: z.boolean(),
});
export const draftSchema = z.object({
  merchant: z.string().max(300), date: z.string().max(10), currency: z.string().regex(/^[A-Z]{3}$/),
  originalCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(), conversionConfirmed: z.boolean(),
  account: z.string().max(100), total: money,
  items: z.array(itemSchema).max(300), adjustments: z.array(adjustmentSchema).max(50),
  warnings: z.array(z.string().max(500)).max(100), warningsReviewed: z.boolean(),
});
export type Draft = z.infer<typeof draftSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Adjustment = z.infer<typeof adjustmentSchema>;
export type Account = { id: string; name: string };
export type Category = { id: string; name: string; group?: string };
export const emptyDraft = (currency = 'USD', account = ''): Draft => ({
  merchant: '', date: '', currency, originalCurrency: null, conversionConfirmed: false,
  account, total: 0, items: [], adjustments: [], warnings: [], warningsReviewed: false,
});
export type Receipt = {
  recognition?: import('./progress.js').RecognitionProgress | null;
  id: string; version: number; status: string; draft: Draft;
  images: { id: string; position: number }[]; created_at: number; updated_at: number;
  error: string | null; cleanup: string; transaction_id: string | null;
  submission_id: string; allocation: Allocation; notesFormatVersion?: number;
};
export type Allocation = { lines: { id: string; base: number; adjustments: { id: string; label: string; amount: number }[]; final: number }[]; sum: number; difference: number; errors: string[] };
export function validDate(date: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && date >= '1900-01-01' && date <= '2200-12-31' && Number.isFinite(new Date(`${date}T12:00:00Z`).getTime()) && new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) === date;
}
// Integer-only largest remainder; ties keep the original receipt order.
export function apportion(amount: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(amount) || amount < 0 || weights.some(w => !Number.isSafeInteger(w) || w < 0)) throw new Error('金额必须为非负整数');
  const total = weights.reduce((s, w) => s + BigInt(w), 0n);
  if (total === 0n) { if (amount === 0) return weights.map(() => 0); throw new Error('请确认费用的分摊商品和金额基数'); }
  const parts = weights.map((w, i) => ({ i, n: BigInt(amount) * BigInt(w) / total, remainder: BigInt(amount) * BigInt(w) % total }));
  let rest = BigInt(amount) - parts.reduce((s, p) => s + p.n, 0n);
  for (const p of [...parts].sort((a, b) => a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1)) if (rest > 0n) { p.n++; rest--; }
  return parts.map(p => Number(p.n));
}
export function allocate(draft: Draft): Allocation {
  const errors: string[] = [];
  const ids = draft.items.map(i => i.id);
  if (new Set(ids).size !== ids.length) errors.push('商品标识重复');
  if (new Set(draft.adjustments.map(a => a.id)).size !== draft.adjustments.length) errors.push('费用标识重复');
  const lines = draft.items.map(i => {
    if (i.discount > i.amount) errors.push(`${i.name || '商品'}的优惠超过原金额`);
    return { id: i.id, base: i.amount - i.discount, adjustments: [] as { id: string; label: string; amount: number }[], final: i.amount - i.discount };
  });
  // Whole-receipt discounts are applied first. Taxes, tips and fees use the same post-discount base.
  let discounted = lines.map(l => l.base);
  for (const a of [...draft.adjustments].sort((a, b) => Number(b.kind === 'discount') - Number(a.kind === 'discount'))) {
    if (a.amount === 0) continue;
    if (a.scope === null || (a.kind === 'tax' && !a.confirmed)) { errors.push(`请确认「${a.label || a.kind}」的分摊范围`); continue; }
    if (Array.isArray(a.scope) && (new Set(a.scope).size !== a.scope.length || a.scope.some(id => !ids.includes(id)))) { errors.push(`「${a.label}」包含无效商品`); continue; }
    const weights = discounted.map((w, i) => a.scope === 'all' || a.scope?.includes(ids[i]) ? Math.max(0, w) : 0);
    if (a.kind === 'discount' && a.amount > weights.reduce((s, w) => s + w, 0)) { errors.push(`「${a.label}」超过可优惠金额`); continue; }
    try {
      const shares = apportion(a.amount, weights);
      shares.forEach((v, i) => { const amount = a.kind === 'discount' ? -v : v; lines[i].final += amount; lines[i].adjustments.push({ id: a.id, label: a.label, amount }); });
      if (a.kind === 'discount') discounted = lines.map(l => l.final);
    } catch (e) { errors.push(`${a.label}: ${(e as Error).message}`); }
  }
  const sum = lines.reduce((s, l) => s + l.final, 0);
  if (!Number.isSafeInteger(sum) || sum > 1_000_000_000 || lines.some(l => l.final < 0)) errors.push('分摊金额超出允许范围');
  return { lines, sum, difference: draft.total - sum, errors };
}
export function validateForSubmit(d: Draft, accounts: Account[], categories: Category[], currency: string) {
  const a = allocate(d); const errors = [...a.errors];
  if (!d.merchant.trim()) errors.push('请填写商家');
  if (!validDate(d.date)) errors.push('请填写有效的小票日期');
  if (!accounts.some(v => v.id === d.account)) errors.push('请选择有效付款账户');
  if (d.currency !== currency) errors.push(`请将金额换算为 ${currency} 并修改记账币种`);
  if (d.originalCurrency && d.originalCurrency !== currency && !d.conversionConfirmed) errors.push('请确认所有商品、优惠和费用已完成人工换算');
  if (!d.items.length || d.total <= 0) errors.push('请填写商品与实付总额');
  d.items.forEach(i => {
    if (!i.name.trim() || !Number.isFinite(Number(i.quantity)) || Number(i.quantity) <= 0) errors.push('请填写商品名称和有效数量');
    const p = i.product;
    if (!p || p.quantityKind === 'unknown') errors.push(`请确认「${i.name}」的数量类型`);
    if (p?.quantityKind === 'count' && !Number.isInteger(Number(i.quantity))) errors.push(`请确认「${i.name}」的购买件数`);
    if (p && ['weight', 'volume'].includes(p.quantityKind) && (!p.unit || !(p.quantityKind === 'weight' ? ['oz','lb','g','kg'] : ['floz','ml','l']).includes(p.unit))) errors.push(`请确认「${i.name}」的计量单位`);
    if (p?.size && Number(p.size.value) <= 0) errors.push(`请确认「${i.name}」的单件规格`);
    if (needsProductReview(p)) errors.push(`请核对「${i.name}」的商品识别结果`);
    if (!categories.some(c => c.id === i.category)) errors.push(`请为「${i.name}」选择有效分类`);
  });
  if (a.difference !== 0) errors.push(`明细与实付相差 ${a.difference} 个最小货币单位`);
  if (d.warnings.length && !d.warningsReviewed) errors.push('请核对识别疑点');
  return { ...a, errors: [...new Set(errors)] };
}
export const formatMoney = (value: number, currency = 'USD') => new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(value / 100);
