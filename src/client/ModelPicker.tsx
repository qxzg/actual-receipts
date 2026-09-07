import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { ModelOption } from '../shared/models';
type Props = {
  provider: 'api' | 'codex'; baseURL: string; apiKey: string; hasKey?: boolean;
  value: string; onChange: (id: string) => void; refreshKey: number;
  secure: (fn: () => Promise<any>) => Promise<any>;
};
export function ModelPicker(props: Props) {
  const [models, setModels] = useState<ModelOption[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), latest = useRef(props); latest.current = props;
  const load = async () => {
    const p = latest.current, request = ++generation.current;
    setError(''); setLoading(true);
    try {
      const fetchModels = () => api<{models:ModelOption[]}>('/settings/models','POST',{provider:p.provider,...(p.provider === 'api' ? {baseURL:p.baseURL,apiKey:p.apiKey} : {})});
      const result: { models: ModelOption[] } = p.provider === 'api' ? await p.secure(fetchModels) : await fetchModels();
      if (request !== generation.current) return;
      setModels(result.models);
      if (!latest.current.value && result.models.length) latest.current.onChange((result.models.find(m=>m.isDefault)||result.models[0]).id);
    } catch (e) { if (request === generation.current) { setModels([]); setError((e as Error).message); } }
    finally { if (request === generation.current) setLoading(false); }
  };
  useEffect(() => {
    ++generation.current; setModels([]); setLoading(false); setError('');
    if (props.provider === 'codex' || props.hasKey && !props.apiKey) void load();
    return () => { ++generation.current; };
  }, [props.provider,props.baseURL,props.apiKey,props.hasKey,props.refreshKey]);
  const chosen = models.find(m=>m.id===props.value);
  return <section className="model-picker" aria-label="选择识别模型">
    <div className="model-picker-heading"><label htmlFor="recognition-model">识别模型</label><button className="quiet" type="button" disabled={loading || props.provider === 'api' && (!props.baseURL || !props.apiKey && !props.hasKey)} onClick={()=>void load()}>{loading?'正在获取…':'刷新模型列表'}</button></div>
    <select id="recognition-model" required disabled={loading || !models.length} value={props.value} onChange={e=>props.onChange(e.target.value)} aria-describedby="model-description">
      <option value="">{loading?'正在获取可用模型':models.length?'选择识别模型':'请先获取模型列表'}</option>
      {props.value && !chosen && <option value={props.value} disabled>已保存：{props.value}（待确认可用性）</option>}
      {models.map(m=><option key={m.id} value={m.id}>{m.name}{m.isDefault?' · 账号默认':''} — {m.description}</option>)}
    </select>
    <p id="model-description" className="model-description">{chosen?.description || (props.provider==='codex'?'完成 ChatGPT 授权后，点击刷新模型列表。':'填入 API 地址和密钥后，获取服务商提供的模型列表。')}</p>
    {error && <p className="model-error" role="alert">{error}</p>}
    {!loading && !error && !models.length && props.provider==='api' && <p className="small muted">图片支持情况以服务商为准，选择后运行图片能力测试。</p>}
    {!!models.length && <details className="model-guide"><summary>查看全部模型简介（{models.length}）</summary><dl>{models.map(m=><div key={m.id}><dt>{m.name}</dt><dd>{m.description}</dd></div>)}</dl></details>}
  </section>;
}
