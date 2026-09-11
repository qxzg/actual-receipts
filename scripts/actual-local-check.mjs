import { emptyProduct } from '../dist/shared/product.js';
import * as api from '@actual-app/api';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { buildTransaction, transactionMatches } from '../dist/server/actual.js';
import { emptyDraft, allocate } from '../dist/shared/receipt.js';
const dataDir=await mkdtemp(join(tmpdir(),'receipt-real-api-'));
try {
  await api.init({dataDir});let account,category;
  await api.runImport('Receipt local integration',async()=>{account=await api.createAccount({name:'Receipt Test'});const group=await api.createCategoryGroup({name:'Tests'});category=await api.createCategory({name:'Groceries',group_id:group});});
  const draft={...emptyDraft('USD',account),merchant:'Receipt Test Merchant',date:'2026-09-06',total:1547,items:[{id:'one',name:'Diet Coke',product:{...emptyProduct('', 'count'),size:{value:'7.5',unit:'floz'},packCount:10},quantity:'4',unitPrice:250,amount:1000,discount:0,category},{id:'two',name:'Foster Farms Free Range Chicken Thighs',product:{...emptyProduct('', 'weight'),unit:'lb'},quantity:'3.2',unitPrice:140,amount:448,discount:0,category}],adjustments:[{id:'tax',kind:'tax',label:'Tax',amount:99,scope:'all',confirmed:true}]};
  const transaction=buildTransaction(draft,allocate(draft),'local-test','98019e1f-12c9-4f3d-a753-a0586f5b4be5');
  await api.addTransactions(account,[transaction],{learnCategories:false,runTransfers:false});
  const rows=await api.getTransactions(account,'2026-09-01','2026-09-10');
  assert.deepEqual(transaction.subtransactions.map(i=>i.notes),['Diet Coke 7.5flozx10x4','Foster Farms Free Range Chicken Thighs 3.2lb $1.40/lb']);
  assert.equal(rows.length,1);assert(transactionMatches(rows[0],transaction),JSON.stringify(rows));assert.equal(await api.getAccountBalance(account),-1547);
  console.log('PASS: Actual 26.9.0 parent, children, notes, category, stable ID and balance verified');
} finally {await api.shutdown();await rm(dataDir,{recursive:true,force:true});}
