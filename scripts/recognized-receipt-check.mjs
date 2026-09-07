// Validate a real model's synthetic fixture output against the dedicated test Actual only.
import * as api from '@actual-app/api';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Store, id, now } from '../dist/server/db.js';
import { ActualBridge } from '../dist/server/actual.js';
import { ReceiptService } from '../dist/server/service.js';
import { cleanupImages } from '../dist/server/images.js';
import { validateForSubmit } from '../dist/shared/receipt.js';
const config=JSON.parse(await readFile('/data/acceptance/test-config.json','utf8'));
assert.equal(config.serverURL,'http://receipts-actual-test:5006');
const draft=JSON.parse(await readFile('/data/acceptance/result.json','utf8'));
assert.equal(draft.items.length,40);assert.equal(draft.total,9623);
const cache='/data/acceptance/account-check';await mkdir(cache,{recursive:true});
await api.init({dataDir:cache,serverURL:config.serverURL,password:config.password});await api.downloadBudget(config.syncId);await api.sync();
const categories=await api.getCategories();const grocery=categories.find(c=>c.name==='Groceries');assert(grocery);
const household=categories.find(c=>c.name==='Household')?.id || await api.createCategory({name:'Household',group_id:grocery.group_id});
const before=await api.getAccountBalance(config.account);await api.sync();await api.shutdown();
// Known fixture supplies the manual review decisions required by the product.
draft.merchant='Receipt Acceptance Test';draft.account=config.account;draft.warningsReviewed=true;
draft.items.forEach(i=>{i.category=i.category==='household'?household:grocery.id});
draft.adjustments.forEach(a=>a.confirmed=true);
const store=new Store('/data/acceptance/ledger',Buffer.alloc(32,41));store.setSetting('actual',config);
const actual=new ActualBridge(store),service=new ReceiptService(store,actual,{},Buffer.alloc(32,41));
const catalog=await actual.catalog();assert.deepEqual(validateForSubmit(draft,catalog.accounts,catalog.categories,'USD').errors,[]);
const receiptID=id(),submissionID=id();store.run("INSERT INTO receipts(id,status,draft,created_at,updated_at,submission_id) VALUES(?,'draft',?,?,?,?)",receiptID,JSON.stringify(draft),now(),now(),submissionID);
const directory=`${store.dir}/images/${receiptID}`;await mkdir(directory,{recursive:true});
for(let i=1;i<=2;i++){const p=`${directory}/${i}.jpg`;await copyFile(`/data/acceptance/part-${i}.jpg`,p);store.run('INSERT INTO images VALUES(?,?,?,?,?)',id(),receiptID,i-1,p,p)}
await service.submit(receiptID,1,submissionID);await service.runSubmission();
assert.equal(service.receipt(receiptID).status,'posted');await cleanupImages(store);assert.equal(service.receipt(receiptID).cleanup,'done');
await service.submit(receiptID,1,submissionID);assert.equal((await actual.duplicates(draft)).length,1);
await api.init({dataDir:cache,serverURL:config.serverURL,password:config.password});await api.downloadBudget(config.syncId);await api.sync();
const after=await api.getAccountBalance(config.account);assert.equal(after,before-9623);await api.shutdown();
console.log(JSON.stringify({passed:true,items:40,expense:9623,balanceDelta:after-before,duplicateParents:1,cleanup:'done'}));store.db.close();
