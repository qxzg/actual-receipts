let csrf = '';
export const setCSRF = (value: string) => { csrf = value; };
export class APIError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const form = body instanceof FormData;
  const response = await fetch('/api' + path, { method, credentials: 'same-origin', headers: { ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...(!form && body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
  let data: any;
  try { data = await response.json(); }
  catch {
    const message = response.status === 502 || response.status === 503 || response.status === 504 || response.status === 524
      ? `服务暂时连接失败（HTTP ${response.status}），请稍后重试`
      : response.status === 413 ? '上传请求超过网关大小限制，请逐张上传'
      : response.status === 403 ? '请求被网关拦截，请刷新页面后重试'
      : `服务返回了异常响应（HTTP ${response.status}），请刷新页面后重试`;
    throw new APIError(response.status, message);
  }
  if (!data || typeof data !== 'object') throw new APIError(response.status, '服务返回了异常数据，请刷新页面后重试');
  if (!response.ok) throw new APIError(response.status, data.error || '请求失败，请重试');
  if (data.csrf) setCSRF(data.csrf);
  return data;
}
