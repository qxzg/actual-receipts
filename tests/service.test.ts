import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, id, now } from '../src/server/db';
import { ReceiptService } from '../src/server/service';
import { buildTransaction, transactionMatches } from '../src/server/actual';
import { cleanupImages } from '../src/server/images';
import { emptyDraft, allocate } from '../src/shared/receipt';
let store: Store, dir: string, svc: ReceiptService, actual: any, writes: any[], receiptID: string, draft: any;
beforeEach(() => {
  dir=mkdtempSync(join(tmpdir(),'receipt-test-')); store=new Store(dir,Buffer.alloc(32,1)); writes=[];
  actual={ connection:()=> 'connection', catalog:async()=>({accounts:[{id:'a',name:'Bank'}],categories:[{id:'c',name:'Food'}],currency:'USD'}), duplicates:async()=>[], write:async(t:any)=>{writes.push(t);return {id:t.id}}, verify:async(t:any)=>({found:writes.length>0,valid:writes.some(w=>w.id===t.id),id:t.id}) };
  svc=new ReceiptService(store,actual,{recognize:async()=>({...draft})} as any,Buffer.alloc(32,1));
  draft={...emptyDraft('USD','a'),merchant:'Test store',date:'2026-09-06',total:101,items:[{id:'one',name:'Test item',quantity:'1',unitPrice:101,amount:101,discount:0,category:'c'}]};
  receiptID=id(); store.run("INSERT INTO receipts(id,status,draft,created_at,updated_at,submission_id) VALUES(?,'draft',?,?,?,?)",receiptID,JSON.stringify(draft),now(),now(),id());
});
afterEach(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
describe('submission and recovery',()=>{
  it('competing edits use optimistic version checks',()=>{ svc.save(receiptID,1,draft); expect(()=>svc.save(receiptID,1,draft)).toThrow('另一页面'); });
  it('requires version-bound duplicate confirmation',async()=>{
    actual.duplicates=async()=>[{id:'dup',date:draft.date,amount:-101,payee:'Test'}]; const r=svc.receipt(receiptID);
    await expect(svc.submit(receiptID,1,r.submission_id)).rejects.toThrow('相同金额');
    const check=await svc.duplicates(receiptID,1); await svc.submit(receiptID,1,r.submission_id,check.token);
    expect(svc.receipt(receiptID).status).toBe('submitting');
  });
  it('two submits create one persistent operation and one write',async()=>{
    const r=svc.receipt(receiptID); await Promise.all([svc.submit(receiptID,1,r.submission_id),svc.submit(receiptID,1,r.submission_id)]);
    expect(store.all('SELECT * FROM submissions')).toHaveLength(1); await (svc as any).runSubmission();
    await svc.submit(receiptID,1,r.submission_id); expect(writes).toHaveLength(1); expect(svc.receipt(receiptID).status).toBe('posted');
  });
  it('keeps the snapshot locked when upstream write outcome is uncertain',async()=>{
    actual.write=async(t:any)=>{writes.push(t);throw new Error('network failure')}; const r=svc.receipt(receiptID); await svc.submit(receiptID,1,r.submission_id); await (svc as any).runSubmission();
    expect(svc.receipt(receiptID).status).toBe('uncertain'); expect(()=>svc.save(receiptID,1,draft)).toThrow();
    svc.recover(); await svc.verify(receiptID); expect(writes).toHaveLength(1); expect(svc.receipt(receiptID).status).toBe('posted');
  });
  it('restart after writing marks uncertain and verifies without adding again',async()=>{
    const r=svc.receipt(receiptID); await svc.submit(receiptID,1,r.submission_id); store.run("UPDATE submissions SET status='writing'"); svc.recover();
    await svc.verify(receiptID); expect(svc.receipt(receiptID).status).toBe('uncertain'); expect(writes).toHaveLength(0);
    await svc.retrySubmission(receiptID); await (svc as any).runSubmission(); expect(writes).toHaveLength(1); expect(svc.receipt(receiptID).submission_id).toBe(r.submission_id);
  });
  it('stops retry when a new duplicate appears',async()=>{
    const r=svc.receipt(receiptID); await svc.submit(receiptID,1,r.submission_id); store.run("UPDATE submissions SET status='writing'");svc.recover();actual.duplicates=async()=>[{id:'new'}]; await expect(svc.retrySubmission(receiptID)).rejects.toThrow('重复候选');expect(writes).toHaveLength(0);
  });
  it('leaves images on error and clears them only after independent readback',async()=>{
    const imageDir=join(dir,'images',receiptID);mkdirSync(imageDir,{recursive:true}); const path=join(imageDir,'test.jpg');writeFileSync(path,'image');store.run('INSERT INTO images VALUES(?,?,?,?,?)',id(),receiptID,0,path,path);
    const r=svc.receipt(receiptID);await svc.submit(receiptID,1,r.submission_id); actual.verify=async()=>({found:false,valid:false});await (svc as any).runSubmission();await cleanupImages(store);expect(existsSync(path)).toBe(true);
    actual.verify=async(t:any)=>({found:true,valid:true,id:t.id});await svc.verify(receiptID);await cleanupImages(store);expect(existsSync(path)).toBe(false);expect(svc.receipt(receiptID).cleanup).toBe('done');expect(svc.receipt(receiptID).draft.items).toHaveLength(1);
  });
  it('parent/child verification detects rule-modified notes, category and amount',()=>{
    const t=buildTransaction(draft,allocate(draft),'sub','parent');expect(transactionMatches(t,t)).toBe(true); const changed=structuredClone(t);changed.subtransactions[0].category='wrong';expect(transactionMatches(changed,t)).toBe(false);expect(t.amount).toBe(-101);expect(t.subtransactions[0].notes).toContain('Test item');
  });
  it('encrypts secrets and authenticates ciphertext',()=>{
    store.setSetting('key',{secret:'PRIVATE-VALUE'});const row=store.get('SELECT value FROM settings');expect(row.value).not.toContain('PRIVATE-VALUE');expect(store.setting('key')).toEqual({secret:'PRIVATE-VALUE'});expect(()=>store.decrypt(row.value.replace(/^./,row.value[0]==='A'?'B':'A'))).toThrow();
  });
});

describe('recognition job recovery', () => {
  function prepare() {
    store.setSetting('model', {provider:'codex'});
    const imageDir=join(dir,'images',receiptID);mkdirSync(imageDir,{recursive:true});
    const path=join(imageDir,'test.jpg');writeFileSync(path,'image');
    store.run('INSERT INTO images VALUES(?,?,?,?,?)',id(),receiptID,0,path,path);
    return path;
  }
  it.each(['识别超时，请重试','额度已耗尽，请切换识别来源'])('retains edited draft and images after %s', async (message) => {
    const path=prepare();
    svc.recognizer.recognize=async()=>{throw new Error(message)};
    svc.enqueueRecognition(receiptID,1,true);
    await (svc as any).runRecognition();
    expect(svc.receipt(receiptID).draft).toEqual(draft);
    expect(svc.receipt(receiptID).error).toBe(message);
    expect(svc.receipt(receiptID).version).toBe(1);
    expect(existsSync(path)).toBe(true);
    svc.recognizer.recognize=async()=>({...draft,merchant:'Retried store'});
    svc.enqueueRecognition(receiptID,1,true);
    await (svc as any).runRecognition();
    expect(svc.receipt(receiptID).version).toBe(2);
    expect(svc.receipt(receiptID).draft.merchant).toBe('Retried store');
  });
  it('restarts queued jobs and keeps interrupted work retryable', async () => {
    prepare();svc.enqueueRecognition(receiptID,1,true);
    svc.recover();expect(svc.receipt(receiptID).status).toBe('queued');
    store.run("UPDATE jobs SET status='running'");store.run("UPDATE receipts SET status='recognizing'");
    svc.recover();expect(svc.receipt(receiptID).status).toBe('failed');
    svc.enqueueRecognition(receiptID,1,true);await (svc as any).runRecognition();
    expect(svc.receipt(receiptID).status).toBe('draft');
  });
});
