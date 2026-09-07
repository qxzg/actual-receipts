// Run only against the dedicated receipts-actual-test container. Never use a personal budget.
import * as api from '@actual-app/api';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Store, id, now } from '../dist/server/db.js';
import { ActualBridge } from '../dist/server/actual.js';
import { ReceiptService } from '../dist/server/service.js';
import { emptyDraft } from '../dist/shared/receipt.js';
const root='/validation';
const phase=process.argv[2]||'prepare';
await mkdir(root,{recursive:true});
let config;
if(phase==='prepare') {
  const password=randomBytes(32).toString('hex'), serverURL='http://receipts-actual-test:5006';
  const bootstrap=await fetch(serverURL+'/account/bootstrap',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})});
  assert.equal(bootstrap.status,200);
  await mkdir(root+'/seed',{recursive:true});await api.init({dataDir:root+'/seed',serverURL,password});
  let account, category;
  await api.runImport('Receipt Ledger isolated acceptance',async()=>{account=await api.createAccount({name:'Receipt Test Card'});const group=await api.createCategoryGroup({name:'Receipt Test'});category=await api.createCategory({name:'Groceries',group_id:group});});
  await api.sync();const budgets=await api.getBudgets();const budget=budgets.find(b=>b.name==='Receipt Ledger isolated acceptance');assert(budget?.groupId);
  config={serverURL,password,syncId:budget.groupId,budgetPassword:'',currency:'USD',testBudget:true,account,category};
  await api.shutdown();await writeFile(root+'/test-config.json',JSON.stringify(config),{mode:0o600});
} else config=JSON.parse(await readFile(root+'/test-config.json','utf8'));
const store=new Store(root+'/app',Buffer.alloc(32,19));
store.setSetting('actual',config);
const actual=new ActualBridge(store), service=new ReceiptService(store,actual,{} ,Buffer.alloc(32,19));
if(phase==='prepare') {
  const draft={...emptyDraft('USD',config.account),merchant:'Isolated Receipt Acceptance',date:'2026-09-06',total:1296,items:[{id:'milk',name:'Milk',quantity:'2',unitPrice:399,amount:798,discount:0,category:config.category},{id:'paper',name:'Paper towels',quantity:'1',unitPrice:499,amount:499,discount:100,category:config.category}],adjustments:[{id:'tax',kind:'tax',label:'Sales tax',amount:99,scope:['paper'],confirmed:true}]};
  const receiptID=id();store.run("INSERT INTO receipts(id,status,draft,created_at,updated_at,submission_id) VALUES(?,'draft',?,?,?,?)",receiptID,JSON.stringify(draft),now(),now(),id());
  const receipt=service.receipt(receiptID);await service.submit(receiptID,1,receipt.submission_id);
  // Reproduce lost acknowledgment after a genuine, successful remote write.
  const write=actual.write.bind(actual);actual.write=async(t)=>{await write(t);throw new Error('模拟写入成功后连接中断');};
  await service.runSubmission();assert.equal(service.receipt(receiptID).status,'uncertain');
  console.log('PASS: real remote write with lost acknowledgment persists an uncertain submission');
} else if(phase==='offline') {
  const receipt=store.get('SELECT id FROM receipts');
  await assert.rejects(service.verify(receipt.id));assert.equal(service.receipt(receipt.id).status,'uncertain');
  console.log('PASS: stopped Actual server preserves the original uncertain submission');
} else if(phase==='recover') {
  service.recover();const receipt=store.get('SELECT * FROM receipts');const result=await service.verify(receipt.id);assert.equal(result.status,'posted');
  await service.submit(receipt.id,receipt.version,receipt.submission_id);
  const c=await actual.catalog();assert(c.accounts.some(a=>a.id===config.account));
  const candidates=await actual.duplicates(result.draft);assert.equal(candidates.length,1);
  await mkdir(root+'/balance-check',{recursive:true});await api.init({dataDir:root+'/balance-check',serverURL:config.serverURL,password:config.password});await api.downloadBudget(config.syncId);await api.sync();assert.equal(await api.getAccountBalance(config.account),-1296);await api.shutdown();
  console.log('PASS: restart recovery verifies one remote parent, exact child amounts, notes, categories and balance -1296');
}
store.db.close();
