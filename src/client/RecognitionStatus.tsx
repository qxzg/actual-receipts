import { useEffect, useState } from 'react';
import { stageLabels, type RecognitionModel } from '../shared/progress';
import type { Receipt } from '../shared/receipt';
import { api } from './api';

export function RecognitionStatus({ record, connectionError, retry }: { record: Receipt; connectionError: string; retry: () => void }) {
  const [time, setTime] = useState(Date.now()), [model, setModel] = useState<RecognitionModel | null>(null);
  const processing = ['queued', 'recognizing'].includes(record.status);
  useEffect(() => {
    if (!processing) return;
    void api<{ model: RecognitionModel | null }>('/recognition-model').then(r => setModel(r.model)).catch(() => {});
    const timer = setInterval(() => setTime(Date.now()), 1000); return () => clearInterval(timer);
  }, [processing]);
  if (!processing && !(record.status === 'draft' && record.draft.items.length)) return null;
  const current = record.recognition || model;
  const seconds = Math.max(0, Math.floor((time - (record.recognition?.startedAt || record.updated_at)) / 1000));
  const stage = record.status === 'queued' ? '等待识别' : record.recognition ? stageLabels[record.recognition.stage] : '正在准备识别';
  return <section className={`recognition-status ${processing ? 'processing' : 'complete'}`} aria-label="识别状态">
    <div className="recognition-title"><span className={processing ? 'spinner' : 'completion-mark'} aria-hidden="true">{processing ? '' : '✓'}</span><div><strong role="status">{connectionError ? '状态更新暂时中断' : processing ? stage : '商品明细已就绪，请核对'}</strong><p>{processing ? current ? `${current.model} · ${current.provider === 'codex' ? 'ChatGPT' : 'API'}` : '正在读取模型信息…' : `已整理 ${record.draft.items.length} 项商品，请对照原图确认金额与分类。`}</p></div>{processing && <span className="elapsed">已用 {seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`}</span>}</div>
    {processing && <><div className="activity-track" aria-hidden="true"><span /></div><ol className="recognition-steps"><li className="done">✓ 图片已上传</li><li className="active">{record.status === 'queued' ? '等待模型' : '模型处理中'}</li><li>核对并入账</li></ol></>}
    {connectionError && <div className="connection-warning" role="alert">{connectionError}<button className="quiet" onClick={retry}>立即重连</button></div>}
  </section>;
}
