import { z } from 'zod';
import type { Item, Allocation } from './receipt.js';

export const units = ['floz', 'ml', 'l', 'oz', 'lb', 'g', 'kg'] as const;
export const decimal = z.string().regex(/^\d{1,8}(\.\d{1,6})?$/);
export const sizeSchema = z.object({ value: decimal, unit: z.enum(units) });
export const sourceSchema = z.object({ title: z.string().max(300), url: z.url().max(2000).regex(/^https?:\/\//) });
export const productSchema = z.object({
  rawName: z.string().max(300), productCode: z.string().max(100).nullable(),
  quantityKind: z.enum(['count', 'weight', 'volume', 'unknown']), unit: z.enum(units).nullable(),
  size: sizeSchema.nullable(), packCount: z.number().int().min(1).max(100000).nullable(),
  lookupStatus: z.enum(['clear', 'pending', 'matched', 'unresolved', 'failed', 'reviewed']),
  lookupReason: z.string().max(500), sources: z.array(sourceSchema).max(5),
});
export type Product = z.infer<typeof productSchema>;
export const emptyProduct = (rawName = '', quantityKind: Product['quantityKind'] = 'unknown'): Product => ({
  rawName, productCode: null, quantityKind, unit: null, size: null, packCount: null,
  lookupStatus: 'clear', lookupReason: '', sources: [],
});
export const needsProductReview = (p: Product | null | undefined) => !!p && ['pending', 'unresolved', 'failed'].includes(p.lookupStatus);
const compactDecimal = (value: string) => /^\d+(\.\d+)?$/.test(value) ? value.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : value;

export function formatItemNotes(item: Item, currency: string): string {
  const p = item.product;
  const name = item.name.trim().replace(/\s+/g, ' ');
  if (!p || p.quantityKind === 'unknown') return name;
  const quantity = compactDecimal(item.quantity);
  if (p.quantityKind === 'weight' || p.quantityKind === 'volume') {
    const parts = [name];
    if (p.unit && Number(quantity) > 0) parts.push(`${quantity}${p.unit}`);
    if (p.unit && item.unitPrice !== null) parts.push(`${currency === 'USD' ? '$' : currency + ' '}${(item.unitPrice / 100).toFixed(2)}/${p.unit}`);
    return parts.join(' ');
  }
  let spec = p.size && Number(p.size.value) > 0 ? `${compactDecimal(p.size.value)}${p.size.unit}` : '';
  if (p.packCount && p.packCount > 1) spec += spec ? `x${p.packCount}` : `${p.packCount}ct`;
  if (Number(quantity) > 1) spec += `x${quantity}`;
  return [name, spec].filter(Boolean).join(' ');
}

// Retained verbatim for submissions created before notes format v2.
export function formatLegacyNotes(i: Item, line: Allocation['lines'][number], currency: string) {
  return `${i.name} × ${i.quantity}；单价 ${i.unitPrice === null ? '待确认' : (i.unitPrice / 100).toFixed(2)}；原价 ${(i.amount / 100).toFixed(2)}；商品优惠 ${(i.discount / 100).toFixed(2)}${line.adjustments.map(a => `；${a.label} ${(a.amount / 100).toFixed(2)}`).join('')} ${currency}`;
}
