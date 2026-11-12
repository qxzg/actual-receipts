import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { ModelOption } from '../shared/models';
type Props = {
  provider: 'api' | 'codex'; baseURL: string; apiKey: string; hasKey?: boolean;
  value: string; onChange: (id: string) => void; refreshKey: number; enabled: boolean;
  onAvailabilityChange: (available: boolean) => void;
  secure: (fn: () => Promise<any>) => Promise<any>;
};
export function ModelPicker(props: Props) {
  const [models, setModels] = useState<ModelOption[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const generation = useRef(0), latest = useRef(props); latest.current = props;
  const activeRequest = useRef<AbortController | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = async () => {
    clearTimeout(refreshTimer.current);
    activeRequest.current?.abort();
    const controller = new AbortController(); activeRequest.current = controller;
    const p = latest.current, request = ++generation.current;
    setError(''); setLoading(true);
    try {
      const fetchModels = () => {
        controller.signal.throwIfAborted();
        return api<{models:ModelOption[]}>('/settings/models','POST',{provider:p.provider,...(p.provider === 'api' ? {baseURL:p.baseURL,apiKey:p.apiKey} : {})},controller.signal);
      };
      const result: { models: ModelOption[] } = p.provider === 'api' ? await p.secure(fetchModels) : await fetchModels();
      if (request !== generation.current) return;
      setModels(result.models); setLoaded(true);
      if (!latest.current.value && result.models.length) latest.current.onChange((result.models.find(m=>m.isDefault)||result.models[0]).id);
    } catch (e) { if (request === generation.current) { setModels([]); setLoaded(false); setError((e as Error).message); } }
    finally { if (request === generation.current) setLoading(false); }
  };
  useEffect(() => {
    ++generation.current; setModels([]); setLoaded(false); setLoading(false); setError('');
    const canLoad = props.enabled && (props.provider === 'codex' || !!props.baseURL && !!(props.apiKey || props.hasKey));
    // Debounce credentials while typing; each completed configuration gets its own catalog.
    refreshTimer.current = canLoad ? setTimeout(() => void load(), props.provider === 'api' ? 500 : 0) : undefined;
    return () => { clearTimeout(refreshTimer.current); ++generation.current; activeRequest.current?.abort(); };
  }, [props.enabled,props.provider,props.baseURL,props.apiKey,props.hasKey,props.refreshKey]);
  const chosen = models.find(m=>m.id===props.value);
  useEffect(() => { props.onAvailabilityChange(!!chosen && !loading && !error); }, [chosen,loading,error,props.onAvailabilityChange]);
  return <section className="model-picker" aria-label="选择识别模型">
    <div className="model-picker-heading"><label htmlFor="recognition-model">识别模型</label><button className="quiet" type="button" disabled={!props.enabled || loading || props.provider === 'api' && (!props.baseURL || !props.apiKey && !props.hasKey)} onClick={()=>void load()}>{loading?'正在获取…':'刷新模型列表'}</button></div>
    <select id="recognition-model" required disabled={loading || !models.length} value={props.value} onChange={e=>props.onChange(e.target.value)} aria-describedby="model-description">
      <option value="">{loading?'正在获取可用模型':models.length?'选择识别模型':loaded?'当前可用模型列表为空':'请先获取模型列表'}</option>
      {props.value && !chosen && <option value={props.value} disabled>已保存：{props.value}（待确认可用性）</option>}
      {models.map(m=><option key={m.id} value={m.id}>{m.name}{m.isDefault?' · 账号默认':''} — {m.description}</option>)}
    </select>
    <p id="model-description" className="model-description">{loading ? '正在从服务器获取最新模型列表…' : chosen?.description || (loaded ? models.length ? '请选择当前列表中的可用模型。' : '当前可用模型列表为空，请刷新或检查账号权限。' : props.provider==='codex'?'完成 ChatGPT 授权后，自动获取账号模型列表。':'填入 API 地址和密钥后，自动获取服务商提供的模型列表。')}</p>
    {error && <p className="model-error" role="alert">{error}</p>}
    {!loading && !error && !models.length && props.provider==='api' && <p className="small muted">图片支持情况以服务商为准，选择后运行图片能力测试。</p>}
    {!!models.length && <details className="model-guide"><summary>查看全部模型简介（{models.length}）</summary><dl>{models.map(m=><div key={m.id}><dt>{m.name}</dt><dd>{m.description}</dd></div>)}</dl></details>}
  </section>;
}
