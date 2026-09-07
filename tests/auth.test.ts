import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/server/app';
import { now, hash, token } from '../src/server/db';
let context: Awaited<ReturnType<typeof createApp>>, dir:string, cookie:string, csrf:string;
const origin='https://receipts.example.test';
async function request(method:any,url:string,payload?:any,headers:any={}){return context.app.inject({method,url,payload,headers:{cookie,origin,'x-csrf-token':csrf,...headers}})}
beforeEach(async()=>{dir=mkdtempSync(join(tmpdir(),'receipt-auth-'));context=await createApp({origin,rpID:'receipts.example.test',dataDir:dir,key:Buffer.alloc(32,7),port:3100,host:'127.0.0.1',trustedProxy:false,providerUrl:'http://provider',providerToken:'internal'}, {workers:false});const r=await context.app.inject('/api/auth/state');cookie=r.headers['set-cookie']!.toString().split(';')[0];csrf=r.json().csrf;});
afterEach(async()=>{await context.app.close();context.store.db.close();rmSync(dir,{recursive:true,force:true});});
function becomeOwner(recent=true){const t=token();cookie='__Host-receipt='+t;csrf=token();context.store.run("INSERT INTO sessions VALUES(?,?,'owner',?,?,?,'test')",hash(t),csrf,now()+600000,recent?now():now()-600000,now());}
describe('auth boundaries',()=>{
  it('sets secure host cookie and private response headers',async()=>{const r=await context.app.inject('/api/auth/state');expect(r.headers['set-cookie']).toContain('__Host-receipt=');expect(r.headers['set-cookie']).toContain('Secure');expect(r.headers['set-cookie']).toContain('HttpOnly');expect(r.headers['set-cookie']).toContain('SameSite=Lax');expect(r.headers['cache-control']).toContain('no-store');});
  it.each(['/api/images/anything','/api/settings','/api/settings/chatgpt','/api/catalog','/api/receipts','/api/auth/passkeys','/api/auth/sessions'])('blocks anonymous reads of %s',async(url)=>{expect((await request('GET',url)).statusCode).toBe(401)});
  it('rejects wrong origins and CSRF on recovery and upload',async()=>{expect((await request('POST','/api/auth/recover',{code:'x'.repeat(30)},{origin:'https://evil.test'})).statusCode).toBe(403);expect((await request('POST','/api/receipts',{}, {'x-csrf-token':'forged'})).statusCode).toBe(403);});
  it('initialization token is atomic and one-time',async()=>{const t=context.store.adminToken('bootstrap');const responses=await Promise.all([request('POST','/api/auth/bootstrap',{token:t}),request('POST','/api/auth/bootstrap',{token:t})]);expect(responses.map(r=>r.statusCode).sort()).toEqual([200,400]);});
  it('bootstrap closes once owner is created',async()=>{const t=context.store.adminToken('bootstrap');context.store.run('INSERT INTO owner VALUES(1,?,?)',token(),now());expect((await request('POST','/api/auth/bootstrap',{token:t})).statusCode).toBe(409);expect(()=>context.store.adminToken('bootstrap')).toThrow();});
  it('recovery code grants only registration and is single-use',async()=>{context.store.run('INSERT INTO owner VALUES(1,?,?)',token(),now());const code=context.store.codes()[0];const r=await request('POST','/api/auth/recover',{code});expect(r.statusCode).toBe(200);cookie=r.headers['set-cookie']!.toString().split(';')[0];csrf=r.json().csrf;expect((await request('GET','/api/settings')).statusCode).toBe(401);expect((await request('POST','/api/auth/recover',{code})).statusCode).toBe(400);expect((await request('POST','/api/auth/register/options',{})).statusCode).toBe(200);});
  it('challenge consumes atomically and is bound to session and action',()=>{const s=context.store; s.run('INSERT INTO challenges VALUES(?,?,?,?,?,?)','c','session','login','value','{}',now()+10000);expect(()=>s.consumeChallenge('other','c','login')).toThrow();expect(()=>s.consumeChallenge('session','c','register')).toThrow();expect(s.consumeChallenge('session','c','login').challenge).toBe('value');expect(()=>s.consumeChallenge('session','c','login')).toThrow();});
  it('enforces recent verification and keeps one passkey',async()=>{becomeOwner(false);expect((await request('POST','/api/auth/recovery-codes',{})).statusCode).toBe(428);becomeOwner();context.store.run('INSERT INTO passkeys VALUES(?,?,?,?,?,?,?)','key','public',0,'[]','my key',now(),null);expect((await request('DELETE','/api/auth/passkeys/key')).statusCode).toBe(400);});
  it('expired session cannot read private resources',async()=>{becomeOwner();context.store.run('UPDATE sessions SET expires=?',now()-1);expect((await request('GET','/api/receipts')).statusCode).toBe(401);});
  it('rejects a fake image despite its declared MIME',async()=>{becomeOwner();const boundary='receipt-test-boundary';const body=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="fake.jpg"\r\nContent-Type: image/jpeg\r\n\r\nnot a real image\r\n--${boundary}--\r\n`);const r=await request('POST','/api/receipts',body,{'content-type':`multipart/form-data; boundary=${boundary}`});expect(r.statusCode).toBeGreaterThanOrEqual(400);expect(context.store.get('SELECT count(*) AS n FROM images')!.n).toBe(0);});
});

it('uploads eight ordered images as individual requests and enforces version/count limits',async()=>{
  becomeOwner();const png=await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).png().toBuffer();
  const boundary='actual-receipt-upload';const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="receipt.png"\r\nContent-Type: image/png\r\n\r\n`),png,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const headers={'content-type':`multipart/form-data; boundary=${boundary}`};
  let response=await request('POST','/api/receipts',body,headers);expect(response.statusCode).toBe(201);let receipt=response.json();
  for(let i=1;i<8;i++) {response=await request('POST',`/api/receipts?receiptId=${receipt.id}&version=${receipt.version}`,body,headers);expect(response.statusCode).toBe(201);receipt=response.json();}
  expect(receipt.images.map((im:any)=>im.position)).toEqual([0,1,2,3,4,5,6,7]);expect(receipt.version).toBe(8);
  expect((await request('POST',`/api/receipts?receiptId=${receipt.id}&version=1`,body,headers)).statusCode).toBe(409);
  expect((await request('POST',`/api/receipts?receiptId=${receipt.id}&version=8`,body,headers)).statusCode).toBe(413);
});
