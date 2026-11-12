import { beforeEach, expect, it, vi } from 'vitest';
import { CodexRPC } from '../src/provider/rpc';
import { listCodexModels } from '../src/provider/models';

vi.mock('../src/provider/rpc', () => ({ CodexRPC: vi.fn() }));
let call: ReturnType<typeof vi.fn>, close: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.mocked(CodexRPC).mockReset();
  call = vi.fn().mockResolvedValue({account:{type:'chatgpt'}}); close = vi.fn();
  vi.mocked(CodexRPC).mockImplementation(function () { return {ready:Promise.resolve(),call,close} as any; });
});
const model = (id: string) => ({model:id,displayName:`Server ${id}`,description:'Server-provided description',inputModalities:['text','image'],isDefault:true});

it('loads a fresh RPC catalog on every request and preserves newly released model metadata', async () => {
  call.mockResolvedValueOnce({account:{type:'chatgpt'}}).mockResolvedValueOnce({data:[model('future-release')],nextCursor:null})
    .mockResolvedValueOnce({account:{type:'chatgpt'}}).mockResolvedValueOnce({data:[model('newer-release')],nextCursor:null});
  expect(await listCodexModels()).toEqual([{id:'future-release',name:'Server future-release',description:'Server-provided description',hidden:undefined,isDefault:true,inputModalities:['text','image']}]);
  expect((await listCodexModels())?.map(m => m.id)).toEqual(['newer-release']);
  expect(CodexRPC).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledTimes(2);
});

it('reads all catalog pages with the server cursor', async () => {
  call.mockResolvedValueOnce({account:{type:'chatgpt'}})
    .mockResolvedValueOnce({data:[model('first')],nextCursor:'next'})
    .mockResolvedValueOnce({data:[model('second')],nextCursor:null});
  expect((await listCodexModels())?.map(m => m.id)).toEqual(['first','second']);
  expect(call.mock.calls).toEqual([['account/read',{refreshToken:false}],['model/list',{includeHidden:false}],['model/list',{includeHidden:false,cursor:'next'}]]);
  expect(close).toHaveBeenCalledOnce();
});

it('requires an authenticated account before fetching models', async () => {
  call.mockResolvedValueOnce({account:null});
  expect(await listCodexModels()).toBeNull();
  expect(call).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledOnce();
});

it('closes the discovery process on upstream errors', async () => {
  call.mockResolvedValueOnce({account:{type:'chatgpt'}}).mockRejectedValueOnce(new Error('catalog unavailable'));
  await expect(listCodexModels()).rejects.toThrow('catalog unavailable');
  expect(close).toHaveBeenCalledOnce();
});

it('stops invalid repeating pagination and releases the process', async () => {
  call.mockResolvedValueOnce({account:{type:'chatgpt'}}).mockResolvedValue({data:[],nextCursor:'same'});
  await expect(listCodexModels()).rejects.toThrow('分页无效');
  expect(call).toHaveBeenCalledTimes(3);
  expect(close).toHaveBeenCalledOnce();
});
