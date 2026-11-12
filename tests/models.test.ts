import { emptyProduct } from '../src/shared/product';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDraft, draftSchema } from '../src/shared/receipt';
import { apiRecognize, Recognizer, normalizeModels, listAPIModels, providerWithProgress } from '../src/server/models';
const settings={provider:'api' as const,baseURL:'https://models.example.test/v1',apiKey:'private-key',model:'vision',protocol:'responses' as const,structured:true};
afterEach(()=>vi.restoreAllMocks());
describe('model adapters',()=>{
  it('sends Responses image input and parses structured text',async()=>{const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:'{"digits":"739251"}'}]}]})));expect(await apiRecognize(settings,['data:image/png;base64,aA=='],'Read digits',{})).toEqual({digits:'739251'});const body=JSON.parse(f.mock.calls[0][1]!.body as string);expect(body.store).toBe(false);expect(body.input[0].content[1].type).toBe('input_image');expect(body.text.format.type).toBe('json_schema');});
  it('supports compatible Chat Completions JSON mode',async()=>{const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})));expect(await apiRecognize({...settings,protocol:'chat',structured:false},['data:image/jpeg;base64,aA=='],'JSON',{})).toEqual({ok:true});const body=JSON.parse(f.mock.calls[0][1]!.body as string);expect(body.response_format.type).toBe('json_object');expect(body.messages[0].content[1].image_url.url).toContain('data:image/jpeg');});
  it.each([401,429,503])('maps HTTP %i without exposing upstream response secrets',async(status)=>{vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response('PRIVATE-UPSTREAM-KEY',{status}));await expect(apiRecognize(settings,[],'test')).rejects.not.toThrow('PRIVATE-UPSTREAM-KEY');});
  it('rejects truncated or malformed model output',async()=>{vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({status:'incomplete',output:[{content:[{type:'output_text',text:'{}'}]}]})));await expect(apiRecognize(settings,[],'test')).rejects.toThrow('截断');});
  it('rejects plaintext endpoints and redirects',async()=>{await expect(apiRecognize({...settings,baseURL:'http://example.test'},[],'test')).rejects.toThrow('HTTPS');});
});

it('keeps a 300-item draft valid when every suggested category is unknown', async () => {
  const draft = { ...emptyDraft(), items: Array.from({length:300}, (_, n) => ({id:String(n),name:`商品 ${n}`,quantity:'1',unitPrice:100,amount:100,discount:0,category:'unknown'})), warnings:Array.from({length:100},(_,n)=>`疑点 ${n}`), warningsReviewed:true };
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(draft)}]}]})));
  const recognizer = new Recognizer({setting:()=>settings} as any, {} as any);
  const result = await recognizer.recognize([], [], 'USD');
  expect(draftSchema.safeParse(result).success).toBe(true);
  expect(result.warnings).toHaveLength(100);
  expect(result.items.every(i=>i.category===null)).toBe(true);
  expect(result.warningsReviewed).toBe(false);
});

describe('model dropdown catalog', () => {
  it('uses server metadata for new and previously filtered model IDs, default first', () => {
    const models=normalizeModels({data:[{id:'future-vision',name:'New Vision',description:'Live server description',inputModalities:['text','image']},{id:'text-only',inputModalities:['text']},{id:'server-default',isDefault:true,inputModalities:['text','image']},{id:'future-vision'},{id:'gpt-5.4-mini',inputModalities:['image']},{id:'hidden-vision',hidden:true,inputModalities:['image']}]});
    expect(models.map(m=>m.id)).toEqual(['server-default','future-vision','gpt-5.4-mini']);
    expect(models[1]).toMatchObject({name:'New Vision',description:'Live server description',vision:true});
  });
  it('uses capability metadata and generic guidance when descriptions are empty', () => {
    const models=normalizeModels({data:[{id:'vendor-vision',name:null,description:' '},{id:'embedding-vision',architecture:{input_modalities:['text','image']}},{id:'audio-only',architecture:{input_modalities:['audio']}},{id:'audio-only',inputModalities:['image']}]});
    expect(models.map(m=>m.id)).toEqual(['vendor-vision','embedding-vision','audio-only']);
    expect(models[0]).toMatchObject({name:'vendor-vision',vision:null,description:'服务商提供的模型，选择后请测试图片能力。'});
    expect(models[1].vision).toBe(true);
  });
  it('fetches a compatible API catalog without returning the key', async () => {
    const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:[{id:'vision-model'}]})));
    const result=await listAPIModels('https://vendor.example/v1/','secret-key');
    expect(f).toHaveBeenCalledWith('https://vendor.example/v1/models',expect.objectContaining({headers:{authorization:'Bearer secret-key'},cache:'no-store',redirect:'error'}));
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });
  it('requests the current upstream catalog on each refresh', async () => {
    const f=vi.spyOn(globalThis,'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({data:[{id:'first-release'}]})))
      .mockResolvedValueOnce(new Response(JSON.stringify({data:[{id:'new-release'}]})));
    expect((await listAPIModels(settings.baseURL,settings.apiKey)).map(m=>m.id)).toEqual(['first-release']);
    expect((await listAPIModels(settings.baseURL,settings.apiKey)).map(m=>m.id)).toEqual(['new-release']);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed catalog responses',()=>{expect(()=>normalizeModels({data:[{id:5}]})).toThrow('格式无效')});
});


describe('recognition to enrichment integration', () => {
  it.each(['api', 'codex'] as const)('routes %s extraction to Codex product lookup with minimal input', async provider => {
    const extracted = { ...emptyDraft('USD'), merchant:'Amazon', date:'2026-09-11', total:999, items:[{
      id:'tool', name:'IGAN 330', quantity:'1', unitPrice:999, amount:999, discount:0, category:'tools',
      product:{...emptyProduct('IGAN 330', 'count'),productCode:'IGAN-330',lookupStatus:'pending'},
    }] };
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/enrich')) {
        const input = JSON.parse(init!.body as string);
        expect(input.model).toBe(provider === 'codex' ? 'vision' : null);
        expect(input.items[0]).not.toHaveProperty('unitPrice');
        expect(input).not.toHaveProperty('images');
        return new Response(JSON.stringify({items:[{id:'tool',name:'IGAN-330 Flush Cutters',size:null,packCount:null,status:'matched',reason:'',sources:[{title:'IGAN product',url:'https://example.com/product'}]}]}));
      }
      return new Response(JSON.stringify(provider === 'codex' ? extracted : { status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(extracted)}]}] }));
    });
    const recognizer = new Recognizer({setting:()=>({...settings,provider})} as any, {providerUrl:'http://provider.test',providerToken:'internal-token'} as any);
    const result = await recognizer.recognize([], [{id:'tools',name:'Tools'}], 'USD');
    expect(f).toHaveBeenCalledTimes(2);
    expect(result.items[0]).toMatchObject({name:'IGAN-330 Flush Cutters',quantity:'1',amount:999,unitPrice:999,category:'tools'});
    expect(result.items[0].product?.lookupStatus).toBe('matched');
  });
});

it('polls scoped provider states, tolerates status failures, and stops after the result', async () => {
  vi.useFakeTimers();
  let finish!: (r: Response) => void;
  let operationID = '', polls = 0;
  const report = vi.fn();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = JSON.parse(init!.body as string);
    if (String(url).endsWith('/recognize')) { operationID = body.progressId; return new Promise<Response>(resolve => { finish = resolve; }); }
    expect(body.id).toBe(operationID); polls++;
    if (polls === 1) throw new Error('temporary progress outage');
    return new Response(JSON.stringify({progress:{stage:'thinking',model:'chosen',rawText:'private'}}));
  });
  try {
    const running = providerWithProgress({providerUrl:'http://provider.test',providerToken:'internal'} as any, '/recognize', {model:'chosen'}, report);
    await vi.advanceTimersByTimeAsync(1600);
    expect(operationID).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.mock.calls).toEqual([['thinking',{provider:'codex',model:'chosen'}]]);
    finish(new Response('{"ok":true}'));
    expect(await running).toEqual({ok:true});
    await vi.advanceTimersByTimeAsync(2400);
    expect(polls).toBe(2);
  } finally { vi.useRealTimers(); }
});

it('reports API request and validation phases for non-streaming providers', async () => {
  vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(emptyDraft())}]}]})));
  const report = vi.fn(), recognizer = new Recognizer({setting:()=>settings} as any, {} as any);
  await recognizer.recognize([], [], 'USD', report);
  expect(report.mock.calls.map(c=>c[0])).toEqual(['preparing','waiting','validating','validating']);
  expect(report.mock.calls.every(c=>c[1].model==='vision' && c[1].provider==='api')).toBe(true);
});
