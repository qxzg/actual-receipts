import { describe, expect, it, vi } from 'vitest';
import { emptyProduct, formatItemNotes, formatLegacyNotes, type Product } from '../src/shared/product';
import { draftSchema, emptyDraft, allocate, validateForSubmit, type Item } from '../src/shared/receipt';
import { enrichProducts } from '../src/server/enrichment';
import { receiptOutputSchema } from '../src/server/models';

const item = (patch: Partial<Item> = {}): Item => ({ id: 'coke', name: 'Diet Coke', quantity: '1', unitPrice: 499, amount: 499, discount: 0, category: 'food', product: emptyProduct('DIET COKE', 'count'), ...patch });
const product = (patch: Partial<Product> = {}): Product => ({ ...emptyProduct('D COKE 75 10PK', 'count'), ...patch });
const draft = (items = [item()]) => ({ ...emptyDraft('USD', 'bank'), merchant: 'Market', date: '2026-09-11', items, total: items.reduce((s, i) => s + i.amount, 0) });
const source = { title: 'Diet Coke product', url: 'https://www.coca-cola.com/us/en/brands/diet-coke' };
const result = (patch = {}) => ({ id: 'coke', name: 'Diet Coke', size: { value: '7.5', unit: 'floz' }, packCount: 10, status: 'matched', reason: '', sources: [source], ...patch });

describe('compact Actual notes', () => {
  it.each(['IGAN-330 Flush Cutters', 'DOTCLAD Wok Pan', 'Diet Coke'])('keeps a single %s concise', name => {
    expect(formatItemNotes(item({ name }), 'USD')).toBe(name);
  });
  it('keeps each package multiplier exactly once', () => {
    expect(formatItemNotes(item({ quantity: '04.000', product: product({ size: { value: '07.500', unit: 'floz' }, packCount: 10 }) }), 'USD')).toBe('Diet Coke 7.5flozx10x4');
    expect(formatItemNotes(item({ product: product({ size: { value: '7.5', unit: 'floz' }, packCount: 10 }) }), 'USD')).toBe('Diet Coke 7.5flozx10');
    expect(formatItemNotes(item({ quantity: '4' }), 'USD')).toBe('Diet Coke x4');
    expect(formatItemNotes(item({ product: product({ packCount: 10 }) }), 'USD')).toBe('Diet Coke 10ct');
    expect(formatItemNotes(item({ product: product({ packCount: 1 }) }), 'USD')).toBe('Diet Coke');
  });
  it('formats measured weight and printed unit price independently of counts and discounts', () => {
    const chicken = item({ name: 'Foster Farms Free Range Chicken Thighs', quantity: '3.200', unitPrice: 140, discount: 100, product: product({ quantityKind: 'weight', unit: 'lb' }) });
    expect(formatItemNotes(chicken, 'USD')).toBe('Foster Farms Free Range Chicken Thighs 3.2lb $1.40/lb');
    expect(formatItemNotes({ ...chicken, unitPrice: null }, 'USD')).toBe('Foster Farms Free Range Chicken Thighs 3.2lb');
    expect(formatItemNotes({ ...chicken, quantity: '1' }, 'USD')).toContain(' 1lb $1.40/lb');
    expect(formatItemNotes(chicken, 'CAD')).toContain('CAD 1.40/lb');
  });
  it('supports volume purchases and unknown old quantities', () => {
    expect(formatItemNotes(item({ quantity: '1.5', product: product({ quantityKind: 'volume', unit: 'l' }) }), 'USD')).toBe('Diet Coke 1.5l $4.99/l');
    expect(formatItemNotes(item({ quantity: '3.2', product: undefined }), 'USD')).toBe('Diet Coke');
  });
  it('preserves legacy notes including allocation details exactly', () => {
    const d = draft(); d.adjustments = [];
    expect(formatLegacyNotes(d.items[0], allocate(d).lines[0], 'USD')).toBe('Diet Coke × 1；单价 4.99；原价 4.99；商品优惠 0.00 USD');
  });
});

describe('product lookup', () => {
  it('deduplicates identical products and only merges description fields', async () => {
    const d = draft([item({ name: 'D COKE', quantity: '4', product: product({ lookupStatus: 'pending' }) }), item({ id: 'second', quantity: '2', product: product({ lookupStatus: 'pending' }) })]);
    const before = structuredClone(d); const lookup = vi.fn().mockResolvedValue({ items: [result({ quantity: '100', amount: 1, unitPrice: 1, category: 'evil' })] });
    await enrichProducts(d, 'selected-codex', lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    const input = lookup.mock.calls[0][0];
    expect(input.model).toBe('selected-codex'); expect(input.items).toHaveLength(1);
    expect(Object.keys(input.items[0]).sort()).toEqual(['id', 'name', 'packCount', 'productCode', 'rawName', 'size']);
    expect(JSON.stringify(input)).not.toContain('bank');
    expect(d.items.map(i => i.name)).toEqual(['Diet Coke', 'Diet Coke']);
    expect(d.items.map(i => ({ ...i, name: '', product: undefined }))).toEqual(before.items.map(i => ({ ...i, name: '', product: undefined })));
    expect(allocate(d)).toEqual(allocate(before));
    expect(d.items[0].product?.sources).toEqual([source]);
    expect(formatItemNotes(d.items[0], 'USD')).toBe('Diet Coke 7.5flozx10x4');
  });
  it('accepts a verified product identity with unknown package count', async () => {
    const d = draft([item({ name: 'IGAN 330', product: product({ lookupStatus: 'pending' }) })]);
    await enrichProducts(d, null, async () => ({ items: [result({ name: 'IGAN-330 Flush Cutters', size: null, packCount: null })] }));
    expect(formatItemNotes(d.items[0], 'USD')).toBe('IGAN-330 Flush Cutters');
    expect(d.items[0].product?.packCount).toBeNull();
    expect(d.items[0].product?.lookupStatus).toBe('matched');
  });
  it('skips clear products and separates different package variants', async () => {
    const lookup = vi.fn(); await enrichProducts(draft(), null, lookup); expect(lookup).not.toHaveBeenCalled();
    const d = draft([item({ product: product({ lookupStatus: 'pending', packCount: 10 }) }), item({ id: 'other', product: product({ lookupStatus: 'pending', packCount: 12 }) })]);
    lookup.mockResolvedValue({ items: [] }); await enrichProducts(d, null, lookup);
    expect(lookup.mock.calls[0][0].items).toHaveLength(2); expect(lookup.mock.calls[0][0].model).toBeNull();
  });
  it.each([
    { status: 'unresolved', reason: '有多个型号' },
    { sources: [] },
    { packCount: 12 },
    { size: { value: '12', unit: 'floz' } },
  ])('retains receipt evidence for ambiguous or conflicting results %j', async patch => {
    const d = draft([item({ name: 'D COKE', product: product({ lookupStatus: 'pending', packCount: 10, size: { value: '7.5', unit: 'floz' } }) })]);
    await enrichProducts(d, null, async () => ({ items: [result(patch)] }));
    expect(d.items[0].name).toBe('D COKE'); expect(d.items[0].product?.packCount).toBe(10); expect(d.items[0].product?.lookupStatus).toBe('unresolved');
  });
  it.each([401, 429, 'timeout'])('keeps extracted data usable after %s', async error => {
    const d = draft([item({ product: product({ lookupStatus: 'pending' }) })]);
    await enrichProducts(d, null, async () => { throw new Error(String(error)); });
    expect(d.items[0].product?.lookupStatus).toBe('failed'); expect(d.total).toBe(499); expect(d.items[0].name).toBe('Diet Coke');
    expect(draftSchema.safeParse(d).success).toBe(true);
  });
  it.each([{ items: [result(), result()] }, { items: [result({ id: 'unknown' })] }, { items: [result({ sources: [{ title: 'unsafe', url: 'javascript:alert(1)' }] })] }])('handles malformed lookup output safely', async response => {
    const d = draft([item({ product: product({ lookupStatus: 'pending' }) })]);
    await enrichProducts(d, null, async () => response); expect(d.items[0].product?.lookupStatus).toBe('failed');
  });
});

describe('review and schema compatibility', () => {
  const errors = (i: Item) => validateForSubmit(draft([i]), [{ id: 'bank', name: 'Bank' }], [{ id: 'food', name: 'Food' }], 'USD').errors;
  it('loads old drafts and requires an explicit quantity type for new submissions', () => {
    expect(draftSchema.safeParse(draft([item({ product: undefined })])).success).toBe(true);
    expect(errors(item({ product: undefined })).join()).toContain('数量类型');
    expect(errors(item())).toEqual([]);
    expect(errors(item({ quantity: '1.5' })).join()).toContain('购买件数');
    expect(errors(item({ product: product({ quantityKind: 'weight', unit: 'l' }) })).join()).toContain('计量单位');
  });
  it('requires acknowledgement of unresolved products', () => {
    expect(errors(item({ product: product({ lookupStatus: 'unresolved' }) })).join()).toContain('商品识别结果');
    expect(errors(item({ product: product({ lookupStatus: 'reviewed' }) }))).toEqual([]);
  });
  it('requires product fields in structured model output while accepting old stored drafts', () => {
    const schema = receiptOutputSchema as any;
    const i = schema.properties.items.items;
    expect(i.required).toContain('product');
    expect(i.properties.product.required).toEqual(Object.keys(i.properties.product.properties));
    expect(i.additionalProperties).toBe(false);
  });
});
