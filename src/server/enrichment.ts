import { enrichmentOutputSchema, type EnrichmentInput } from '../shared/enrichment.js';
import type { Draft } from '../shared/receipt.js';

export async function enrichProducts(draft: Draft, model: string | null, lookup: (input: EnrichmentInput) => Promise<unknown>) {
  const groups = new Map<string, typeof draft.items>();
  for (const item of draft.items) {
    const p = item.product;
    if (!p || p.lookupStatus !== 'pending') continue;
    const key = JSON.stringify([p.rawName.trim().toLowerCase(), p.productCode, p.size, p.packCount]);
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  if (!groups.size) return;
  const groupsById = new Map([...groups.values()].map(items => [items[0].id, items]));
  try {
    const input: EnrichmentInput = { merchant: draft.merchant, model, items: [...groupsById.values()].map(([item]) => ({
      id: item.id, name: item.name, rawName: item.product!.rawName, productCode: item.product!.productCode,
      size: item.product!.size, packCount: item.product!.packCount,
    })) };
    const result = enrichmentOutputSchema.parse(await lookup(input));
    if (new Set(result.items.map(i => i.id)).size !== result.items.length || result.items.some(i => !groupsById.has(i.id))) throw new Error('Invalid item IDs');
    for (const [id, items] of groupsById) {
      const match = result.items.find(i => i.id === id);
      for (const item of items) {
        const p = item.product!;
        const conflict = match && ((p.size && match.size && (Number(p.size.value) !== Number(match.size.value) || p.size.unit !== match.size.unit)) || (p.packCount && match.packCount && p.packCount !== match.packCount));
        if (match?.status === 'matched' && match.sources.length && !conflict) {
          item.name = match.name;
          p.size ??= match.size;
          p.packCount ??= match.packCount;
          p.sources = match.sources;
          p.lookupStatus = 'matched'; p.lookupReason = '';
        } else {
          p.lookupStatus = 'unresolved';
          p.sources = match?.sources || [];
          p.lookupReason = conflict ? '查询到的包装规格与小票有差异，请核对商品。' : match?.reason || '商品匹配依据不足，请核对名称和规格。';
        }
      }
    }
  } catch {
    for (const items of groupsById.values()) for (const item of items) {
      item.product!.lookupStatus = 'failed';
      item.product!.lookupReason = '商品查询暂时失败，请检查 ChatGPT 授权或核对名称和规格。';
    }
  }
}
