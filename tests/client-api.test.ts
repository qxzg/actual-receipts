import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, APIError, setCSRF } from '../src/client/api';
afterEach(()=>vi.restoreAllMocks());
describe('browser API error handling',()=>{
  it.each([502,503,504,524])('maps HTML gateway %i to an actionable error',async status=>{
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('<html>Cloudflare Bad gateway</html>',{status,headers:{'content-type':'text/html'}}));
    await expect(api('/settings/chatgpt/login','POST',{})).rejects.toMatchObject({status,message:`服务暂时连接失败（HTTP ${status}），请稍后重试`});
  });
  it('keeps CSRF refresh and safe structured error messages',async()=>{
    const f=vi.spyOn(globalThis,'fetch');setCSRF('before');
    f.mockResolvedValueOnce(new Response(JSON.stringify({csrf:'after'})));
    await api('/auth/state');
    f.mockResolvedValueOnce(new Response(JSON.stringify({error:'请先完成一次 Passkey 验证'}),{status:428}));
    await expect(api('/settings/chatgpt/login','POST',{})).rejects.toBeInstanceOf(APIError);
    expect(f.mock.calls[1][1]?.headers).toMatchObject({'x-csrf-token':'after'});
  });
  it.each(['null','false','<html>unexpected</html>'])('handles malformed successful response %s',async body=>{
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(body));
    await expect(api('/auth/state')).rejects.toBeInstanceOf(APIError);
  });
});
