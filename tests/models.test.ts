import { emptyProduct } from '../src/shared/product';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDraft, draftSchema } from '../src/shared/receipt';
import { apiRecognize, Recognizer, normalizeModels, listAPIModels } from '../src/server/models';
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
  it('lists image models, removes duplicates and retired subscription models, default first', () => {
    const models=normalizeModels({data:[{id:'gpt-5.6-luna',inputModalities:['text','image']},{id:'text-only',inputModalities:['text']},{id:'gpt-6-astra',isDefault:true,inputModalities:['text','image']},{id:'gpt-5.6-luna'},{id:'gpt-5.4-mini',inputModalities:['image']}]},'codex');
    expect(models.map(m=>m.id)).toEqual(['gpt-6-astra','gpt-5.6-luna']);
    expect(models.every(m=>m.description.length>5)).toBe(true);
  });
  it('marks unknown API image support honestly and filters specialized models', () => {
    const models=normalizeModels({data:[{id:'vendor-vision'},{id:'text-embedding-3-small'},{id:'gpt-5.4-mini'}]},'api');
    expect(models.map(m=>m.id)).toContain('gpt-5.4-mini');
    expect(models.find(m=>m.id==='vendor-vision')).toMatchObject({vision:null,description:'服务商提供的模型，选择后请测试图片能力。'});
    expect(models.map(m=>m.id)).not.toContain('text-embedding-3-small');
  });
  it('fetches a compatible API catalog without returning the key', async () => {
    const f=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:[{id:'vision-model'}]})));
    const result=await listAPIModels('https://vendor.example/v1/','secret-key');
    expect(f).toHaveBeenCalledWith('https://vendor.example/v1/models',expect.objectContaining({headers:{authorization:'Bearer secret-key'},redirect:'error'}));
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });
  it('rejects malformed catalog responses',()=>{expect(()=>normalizeModels({data:[{id:5}]},'api')).toThrow('格式无效')});
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
