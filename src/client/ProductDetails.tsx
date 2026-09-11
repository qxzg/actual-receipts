import type { Item, Allocation } from '../shared/receipt';
import { emptyProduct, formatItemNotes, formatLegacyNotes, needsProductReview, units, type Product } from '../shared/product';

export function ProductDetails({ item, index, currency, version, line, onChange }: {
  item: Item; index: number; currency: string; version: number; line: Allocation['lines'][number]; onChange: (product: Product) => void;
}) {
  const p = item.product || emptyProduct(item.name);
  const prefix = `商品 ${index + 1}`;
  const change = (patch: Partial<Product>) => onChange({ ...p, ...patch });
  return <div className="product-details">
    <p className="notes-preview"><span>Actual 备注</span><output aria-label={`${prefix} 备注`}>{version === 1 ? formatLegacyNotes(item, line, currency) : formatItemNotes(item, currency)}</output></p>
    {version !== 1 && <>
      <div className="field-grid">
        <label className="field">数量类型<select aria-label={`${prefix} 数量类型`} value={p.quantityKind} onChange={e => change({ quantityKind: e.target.value as Product['quantityKind'], unit: null })}>
          <option value="unknown">待确认数量类型</option><option value="count">件 / 包</option><option value="weight">称重</option><option value="volume">按体积</option>
        </select></label>
        {['weight', 'volume'].includes(p.quantityKind) && <label className="field">计量单位<select aria-label={`${prefix} 计量单位`} value={p.unit || ''} onChange={e => change({ unit: e.target.value as Product['unit'] || null })}>
          <option value="">选择单位</option>{(p.quantityKind === 'weight' ? ['oz', 'lb', 'g', 'kg'] : ['floz', 'ml', 'l']).map(u => <option key={u}>{u}</option>)}
        </select></label>}
      </div>
      {p.quantityKind === 'unknown' && <p className="small warning">请确认票面数量表示购买件数、重量或体积。</p>}
      {needsProductReview(p) && <div className="warning product-warning"><p>{p.lookupReason || '请核对商品名称和规格。'}</p><label className="check"><input aria-label={`${prefix} 已核对商品信息`} type="checkbox" checked={false} onChange={() => change({ lookupStatus: 'reviewed' })} />已核对商品名称和规格</label></div>}
      {p.lookupStatus === 'reviewed' && <p className="small muted">商品信息已人工核对</p>}
      <details><summary>规格与识别依据</summary>
        {p.quantityKind === 'count' && <div className="field-grid">
          <label className="field">单件容量 / 重量<input aria-label={`${prefix} 单件规格`} inputMode="decimal" value={p.size?.value || ''} placeholder="如 7.5" onChange={e => change({ size: e.target.value ? { value: e.target.value, unit: p.size?.unit || 'floz' } : null })} /></label>
          <label className="field">规格单位<select aria-label={`${prefix} 规格单位`} value={p.size?.unit || 'floz'} onChange={e => change({ size: { value: p.size?.value || '', unit: e.target.value as NonNullable<Product['size']>['unit'] } })}>{units.map(u => <option key={u}>{u}</option>)}</select></label>
          <label className="field">每包件数<input aria-label={`${prefix} 每包件数`} inputMode="numeric" type="number" min="1" max="100000" step="1" value={p.packCount ?? ''} placeholder="如 10" onChange={e => change({ packCount: e.target.value ? Number(e.target.value) : null })} /></label>
          <p className="small muted">购买包数填写在上方「数量 / 重量」中。</p>
        </div>}
        <label className="field">商品代码<input aria-label={`${prefix} 商品代码`} maxLength={100} value={p.productCode || ''} onChange={e => change({ productCode: e.target.value || null })} /></label>
        {p.lookupStatus === 'reviewed' && p.lookupReason && <p className="small muted">查询提示：{p.lookupReason}</p>}
        {p.rawName && <p className="small">票面原文：{p.rawName}</p>}
        {!!p.sources.length && <ul className="product-sources">{p.sources.map((source, i) => <li key={`${source.url}-${i}`}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a></li>)}</ul>}
      </details>
    </>}
  </div>;
}
