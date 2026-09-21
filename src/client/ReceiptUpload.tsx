import { useEffect, useRef, useState } from 'react';
import type { Catalog } from '../server/actual';
import type { Receipt } from '../shared/receipt';
import type { RecognitionModel } from '../shared/progress';
import { api } from './api';

type Photo = { id: string; file: File; url: string; invalid?: boolean };
const accept = 'image/jpeg,image/png,image/webp';

export function ReceiptUpload({ catalog, busy, run, open, onPendingChange }: {
  catalog: Catalog; busy: boolean; run: (fn: () => Promise<any>) => Promise<void>;
  open: (id: string) => void; onPendingChange: (pending: boolean) => void;
}) {
  const [photos, setPhotos] = useState<Photo[]>([]), [account, setAccount] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [model, setModel] = useState<RecognitionModel | null>(null), [modelState, setModelState] = useState('loading');
  const [saved, setSaved] = useState<{ receipt: Receipt; count: number } | null>(null);
  const [preview, setPreview] = useState<Photo | null>(null);
  const working = useRef(false), urls = useRef(new Set<string>()), dialog = useRef<HTMLDialogElement>(null);
  const locked = busy || !!message;
  const validAccount = catalog.accounts.some(a => a.id === account);
  const loadModel = async () => {
    setModelState('loading');
    try { const result = await api<{ model: RecognitionModel | null }>('/recognition-model'); setModel(result.model); setModelState('ready'); }
    catch { setModelState('error'); }
  };
  useEffect(() => {
    void loadModel();
    const refresh = () => { if (!working.current) void loadModel(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => () => { urls.current.forEach(url => URL.revokeObjectURL(url)); }, []);
  useEffect(() => { onPendingChange(photos.length > 0); return () => onPendingChange(false); }, [photos.length, onPendingChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (photos.length) event.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [photos.length]);
  useEffect(() => { if (preview) dialog.current?.showModal(); }, [preview]);
  const release = (photo: Photo) => { URL.revokeObjectURL(photo.url); urls.current.delete(photo.url); };
  const select = (files: File[], replace?: number) => {
    if (working.current || locked || !files.length) return;
    if (photos.length + files.length - (replace === undefined ? 0 : 1) > 8) { setError('每张小票最多选择 8 张照片。'); return; }
    const invalid = files.find(file => !accept.split(',').includes(file.type) || file.size === 0 || file.size > 15 * 1024 * 1024);
    if (invalid) { setError(`${invalid.name}：请选择 JPG、PNG 或 WebP 图片，每张大于 0 且最多 15 MiB。`); return; }
    const added = files.map(file => { const url = URL.createObjectURL(file); urls.current.add(url); return { id: crypto.randomUUID(), file, url }; });
    if (replace === undefined) setPhotos([...photos, ...added]);
    else { release(photos[replace]); setPhotos(photos.map((photo, index) => index === replace ? added[0] : photo)); }
    setError('');
  };
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (event.defaultPrevented || working.current || locked || preview || dialog.current?.open) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.closest('input, textarea') || target.isContentEditable)) return;
      const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
      if (!files.length) return;
      event.preventDefault();
      select(files.map(file => {
        if (file.name.trim()) return file;
        const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
        return new File([file], `clipboard-${crypto.randomUUID()}${extension ? `.${extension}` : ''}`, { type: file.type, lastModified: file.lastModified });
      }));
    };
    window.addEventListener('paste', paste);
    return () => window.removeEventListener('paste', paste);
  });
  const upload = () => {
    if (working.current || locked) return;
    working.current = true;
    void run(async () => {
      let current = saved?.receipt, count = saved?.count || 0;
      setError(''); setMessage('正在准备上传…');
      try {
        // Reconcile an append whose response was interrupted before retrying it.
        if (current) {
          current = await api<Receipt>(`/receipts/${current.id}`);
          if (['queued', 'recognizing'].includes(current.status) || current.draft.items.length) { open(current.id); return; }
          if (!['draft', 'failed'].includes(current.status)) throw new Error('草稿状态已更新，请打开已保存草稿查看。');
          count = current.images.length;
          setSaved({ receipt: current, count });
        }
        for (let index = count; index < photos.length; index++) {
          setMessage(`正在上传第 ${index + 1}／${photos.length} 张`);
          const form = new FormData(); form.append('images', photos[index].file);
          const query = current ? new URLSearchParams({ receiptId: current.id, version: String(current.version) }) : new URLSearchParams({ account });
          current = await api<Receipt>(`/receipts?${query}`, 'POST', form);
          count = index + 1; setSaved({ receipt: current, count });
        }
        if (current) {
          setMessage('上传完成，正在启动识别…');
          await api(`/receipts/${current.id}/recognize`, 'POST', { version: current.version, replace: false });
          onPendingChange(false); open(current.id);
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : '操作失败，请重试';
        setError(current ? `${count} 张照片已保存。${detail}` : detail);
      } finally { setMessage(''); working.current = false; }
    });
  };
  const picker = (label: string, replace?: number) => <label className={replace === undefined ? 'photo-add' : 'photo-replace'}>
    <span>{label}</span><input aria-label={replace === undefined ? '小票图片' : `替换第 ${replace + 1} 张照片`} type="file" accept={accept} multiple={replace === undefined} disabled={locked || (replace !== undefined && replace < (saved?.count || 0))} onChange={event => { select(Array.from(event.target.files || []), replace); event.target.value = ''; }} />
  </label>;
  return <section className={`upload-panel receipt-upload ${photos.length ? 'has-photos' : ''}`} aria-label="添加小票">
    <div className="upload-images">
      <div className="section-heading"><div><span className="eyebrow">记录一笔开支</span><h2>添加一张小票</h2></div><span className={`selection-count ${photos.length ? 'selected' : ''}`} role="status">{photos.length ? `✓ 已选择 ${photos.length} 张` : '通常 1–2 张照片'}</span></div>
      <p className="muted">拍下整张小票；长小票可补充照片，按顺序一起识别。</p>
      <p className="muted small">支持 Ctrl+V / ⌘V 粘贴图片</p>
      {photos.length ? <div className={`photo-grid ${photos.length === 1 ? 'single-photo' : ''}`}>{photos.map((photo, index) => <article className="photo-card" key={photo.id}>
        <button className="photo-preview" aria-label={`查看第 ${index + 1} 张照片`} onClick={() => setPreview(photo)}><img src={photo.url} alt={`已选择的小票第 ${index + 1} 张`} onError={() => { setPhotos(current => current.map(p => p.id === photo.id ? { ...p, invalid: true } : p)); setError('图片读取失败，请替换或删除对应照片。'); }} /><span className="photo-number">{String(index + 1).padStart(2, '0')}</span><span className="photo-zoom">查看大图 ↗</span></button>
        <div className="photo-caption"><strong title={photo.file.name}>{photo.file.name}</strong><small>{photo.invalid ? '图片读取失败' : index < (saved?.count || 0) ? '✓ 已上传' : `${photo.file.size < 1024 * 1024 ? `${Math.ceil(photo.file.size / 1024)} KiB` : `${(photo.file.size / 1024 / 1024).toFixed(1)} MiB`} · 待上传`}</small></div>
        <div className="photo-actions">{picker('替换', index)}<button disabled={locked || index < (saved?.count || 0)} aria-label={`删除第 ${index + 1} 张照片`} onClick={() => { release(photo); setPhotos(photos.filter(p => p.id !== photo.id)); setError(''); }}>删除</button>{index > 0 && <button disabled={locked || index - 1 < (saved?.count || 0)} aria-label={`将第 ${index + 1} 张照片前移`} onClick={() => { const next = [...photos]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setPhotos(next); }}>前移</button>}</div>
      </article>)}{photos.length < 8 && picker('＋ 补充照片')}</div> : <label className="dropzone"><span className="upload-icon" aria-hidden="true">＋</span><strong>选择图片或拍照</strong><span>JPG · PNG · WebP，每张最多 15 MiB</span><input aria-label="小票图片" type="file" accept={accept} multiple disabled={locked} onChange={event => { select(Array.from(event.target.files || [])); event.target.value = ''; }} /></label>}
      {error && <div className="upload-error" role="alert">{error}</div>}
    </div>
    <div className="upload-options">
      <div className="current-model"><span className="model-symbol" aria-hidden="true">✦</span><div><span className="eyebrow">当前识别模型</span><strong>{modelState === 'loading' ? '正在读取模型…' : modelState === 'error' ? '模型信息加载失败' : model?.model || '请在设置中选择模型'}</strong>{modelState === 'ready' && model && <small>{model.provider === 'codex' ? 'ChatGPT 授权' : '兼容 API'}</small>}</div>{modelState === 'error' && <button className="quiet" onClick={() => void loadModel()}>重试</button>}</div>
      <div className="field"><label htmlFor="upload-account">付款账户</label><select id="upload-account" value={account} disabled={locked || !!saved} onChange={event => setAccount(event.target.value)}><option value="">选择付款账户</option>{catalog.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></div>
      <p id="upload-hint" className="upload-hint">{!photos.length ? '选择照片后即可开始' : !validAccount ? '请选择付款账户' : photos.length === 1 ? '照片已就绪，可以开始识别' : `${photos.length} 张照片将合并识别为一笔小票`}</p>
      <button className="primary wide" aria-describedby="upload-hint" disabled={locked || !photos.length || photos.some(p => p.invalid) || !validAccount || !model || modelState !== 'ready'} onClick={upload}>{message ? <><span className="spinner" aria-hidden="true" />处理中…</> : saved ? saved.count < photos.length ? '继续上传并识别 →' : '重试识别 →' : '上传并识别 →'}</button>
      {message && <div className="upload-progress" role="status"><progress max={photos.length} value={saved?.count || 0} aria-label="照片上传进度" /><span>{message}</span></div>}
      {saved && !message && <button className="quiet wide" onClick={() => open(saved.receipt.id)}>打开已保存草稿</button>}
      <p className="upload-footnote">识别后核对商品与金额，再确认入账。<br />成功入账后，图片会自动清理。</p>
    </div>
    <dialog ref={dialog} className="photo-dialog" onClose={() => setPreview(null)} aria-label="小票照片预览"><form method="dialog"><button aria-label="关闭照片预览">关闭 ×</button></form>{preview && <img src={preview.url} alt={preview.file.name} />}</dialog>
  </section>;
}
