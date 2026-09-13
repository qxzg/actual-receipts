import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { allocate, emptyDraft, type Receipt } from '../../src/shared/receipt';

const model = { provider: 'codex', model: 'gpt-6-astra' };
const draft = emptyDraft('USD', 'bank');
const receipt = (): Receipt => ({ id:'receipt-one',version:1,status:'draft',draft:structuredClone(draft),images:[],created_at:Date.now(),updated_at:Date.now(),error:null,cleanup:'retained',transaction_id:null,submission_id:'submission',allocation:allocate(draft) });
const photo = async (name = 'receipt-top.png') => ({ name,mimeType:'image/png',buffer:await sharp(Buffer.from('<svg width="480" height="760"><rect width="480" height="760" fill="#fffdf7"/><text x="45" y="85" font-family="monospace" font-size="28">NEIGHBORHOOD MARKET</text><path d="M45 115H435M45 430H435" stroke="#333" stroke-dasharray="5 5"/><text x="45" y="180" font-size="22">MILK                 7.98</text><text x="45" y="240" font-size="22">TOWEL                4.99</text><text x="45" y="300" font-size="22">DISCOUNT            -1.00</text><text x="45" y="360" font-size="22">TAX                   .99</text><text x="45" y="500" font-size="28">TOTAL     $12.96</text><text x="110" y="650" font-size="20">THANK YOU</text></svg>')).png().toBuffer() });
async function home(page: Page) {
  await page.route('**/api/auth/state', r => r.fulfill({json:{authenticated:true,csrf:'test'}}));
  await page.route('**/api/catalog', r => r.fulfill({json:{accounts:[{id:'bank',name:'日常银行卡'}],categories:[],currency:'USD'}}));
  await page.route('**/api/recognition-model', r => r.fulfill({json:{model}}));
  await page.route('**/api/receipts?**', r => r.fulfill({json:[]}));
  await page.goto('/');
  await expect(page.getByText(model.model,{exact:true})).toBeVisible();
}

test('single photo, supplemental photo, preview, reorder and selection validation', async ({page}) => {
  await home(page);
  const first = await photo(), second = await photo('receipt-bottom.png');
  await page.getByLabel('小票图片',{exact:true}).setInputFiles(first);
  await expect(page.getByText('✓ 已选择 1 张',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'上传并识别 →',exact:true})).toBeDisabled();
  await page.getByLabel('付款账户',{exact:true}).selectOption('bank');
  await expect(page.getByRole('button',{name:'上传并识别 →',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'查看第 1 张照片'}).click();
  await expect(page.getByRole('dialog',{name:'小票照片预览'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.screenshot({path:'artifacts/upload-single-desktop.png',fullPage:true});
  await page.getByLabel('小票图片',{exact:true}).setInputFiles(second);
  await expect(page.getByText('✓ 已选择 2 张',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'将第 2 张照片前移'}).click();
  await expect(page.locator('.photo-card').first()).toContainText('receipt-bottom.png');
  await page.getByLabel('替换第 1 张照片').setInputFiles(await photo('replacement.png'));
  await expect(page.locator('.photo-card').first()).toContainText('replacement.png');
  await page.getByLabel('小票图片',{exact:true}).setInputFiles({name:'document.pdf',mimeType:'application/pdf',buffer:Buffer.from('invalid')});
  await expect(page.getByRole('alert')).toContainText('JPG、PNG 或 WebP');
  await expect(page.locator('.photo-card')).toHaveCount(2);
  await page.getByLabel('小票图片',{exact:true}).setInputFiles({name:'large.png',mimeType:'image/png',buffer:Buffer.alloc(15*1024*1024+1)});
  await expect(page.getByRole('alert')).toContainText('15 MiB');
  await page.getByLabel('小票图片',{exact:true}).setInputFiles(Array.from({length:7},()=>first));
  await expect(page.getByRole('alert')).toContainText('最多选择 8 张');
  await page.getByRole('button',{name:'删除第 2 张照片'}).click();
  await page.getByLabel('小票图片',{exact:true}).setInputFiles(first);
  await expect(page.locator('.photo-card')).toHaveCount(2);
  await page.screenshot({path:'artifacts/upload-two-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'artifacts/upload-two-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByText('日期筛选',{exact:true}).click();
  await expect(page.getByLabel('开始日期')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole('button',{name:'删除第 2 张照片'}).click();
  await page.getByRole('button',{name:'删除第 1 张照片'}).click();
  await page.getByLabel('小票图片',{exact:true}).setInputFiles(first);
  await expect(page.getByText('✓ 已选择 1 张',{exact:true})).toBeVisible();
});

test('partial upload retries the same receipt and exposes live model status', async ({page}) => {
  await home(page);
  const current = receipt(), uploaded: string[] = [];
  let calls = 0, failAppend = true, failPoll = false, recognizeCalls = 0;
  await page.route('**/api/receipts?**', async route => {
    if (route.request().method() === 'GET') return route.fulfill({json:[]});
    calls++;
    if (calls === 2 && failAppend) { failAppend = false; return route.fulfill({status:502,json:{error:'第二张上传失败，请重试'}}); }
    const url = new URL(route.request().url());
    if (calls === 1) expect(url.searchParams.get('account')).toBe('bank');
    else { expect(url.searchParams.get('receiptId')).toBe(current.id); expect(url.searchParams.get('version')).toBe(String(current.version)); current.version++; }
    uploaded.push(route.request().postDataBuffer()!.toString().match(/filename="([^"]+)"/)![1]);
    current.images.push({id:`image-${uploaded.length}`,position:uploaded.length-1});
    await route.fulfill({json:current});
  });
  await page.route('**/api/receipts/receipt-one', route => failPoll ? route.fulfill({status:503,json:{error:'offline'}}) : route.fulfill({json:current}));
  await page.route('**/api/receipts/receipt-one/recognize', async route => {
    recognizeCalls++;
    expect(route.request().postDataJSON()).toEqual({version:2,replace:false});
    current.status='recognizing'; current.recognition={...model,provider:'codex',stage:'thinking',startedAt:Date.now()};
    await route.fulfill({json:{jobId:'job'}});
  });
  await page.route('**/api/images/*', async r => r.fulfill({contentType:'image/png',body:(await photo()).buffer}));
  await page.getByLabel('小票图片',{exact:true}).setInputFiles([await photo(),await photo('receipt-bottom.png')]);
  await page.getByLabel('付款账户',{exact:true}).selectOption('bank');
  await page.getByRole('button',{name:'上传并识别 →',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('1 张照片已保存');
  await expect(page.getByRole('button',{name:'删除第 1 张照片'})).toBeDisabled();
  await page.getByRole('button',{name:'继续上传并识别 →',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'模型思考中'})).toBeVisible();
  expect(uploaded).toEqual(['receipt-top.png','receipt-bottom.png']);
  expect(calls).toBe(3); expect(recognizeCalls).toBe(1);
  await expect(page.getByLabel('识别状态')).toContainText(model.model);
  await page.screenshot({path:'artifacts/recognition-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'artifacts/recognition-mobile.png',fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  failPoll=true;
  await expect(page.getByText('状态更新暂时中断',{exact:true})).toBeVisible();
  failPoll=false; current.recognition!.stage='generating';
  await page.getByRole('button',{name:'立即重连'}).click();
  await expect(page.getByRole('status').filter({hasText:'正在生成识别结果'})).toBeVisible();
  current.status='failed'; current.recognition=null; current.error='识别失败，请重试';
  await expect(page.getByRole('alert')).toContainText('识别失败');
  await expect(page.getByRole('button',{name:'识别小票',exact:true})).toBeEnabled();
});

test('single photo survives recognition-start failure and retry creates one job', async ({page}) => {
  await home(page);
  const current=receipt(); let uploads=0,starts=0;
  await page.route('**/api/receipts?**', async r => {
    if(r.request().method()==='GET') return r.fulfill({json:[]});
    uploads++; current.images=[{id:'image',position:0}]; await r.fulfill({json:current});
  });
  await page.route('**/api/receipts/receipt-one', r=>r.fulfill({json:current}));
  await page.route('**/api/receipts/receipt-one/recognize', async r=>{
    starts++; if(starts===1) return r.fulfill({status:422,json:{error:'请先在设置中选择识别来源'}});
    current.status='queued'; await r.fulfill({json:{jobId:'one'}});
  });
  await page.route('**/api/images/*', async r => r.fulfill({contentType:'image/png',body:(await photo()).buffer}));
  await page.getByLabel('小票图片',{exact:true}).setInputFiles(await photo());
  await page.getByLabel('付款账户',{exact:true}).selectOption('bank');
  await page.getByRole('button',{name:'上传并识别 →',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('1 张照片已保存');
  await page.getByRole('button',{name:'重试识别 →',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'等待识别'})).toBeVisible();
  expect(uploads).toBe(1); expect(starts).toBe(2);
});

test('homepage refreshes the configured model and recovers a model read failure', async ({page}) => {
  await home(page);
  let fail = true;
  await page.route('**/api/recognition-model', r => fail ? r.fulfill({status:503,json:{error:'offline'}}) : r.fulfill({json:{model:{provider:'api',model:'my-vision-model'}}}));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('模型信息加载失败',{exact:true})).toBeVisible();
  fail = false;
  await page.locator('.current-model').getByRole('button',{name:'重试',exact:true}).click();
  await expect(page.getByText('my-vision-model',{exact:true})).toBeVisible();
  await expect(page.getByText('兼容 API',{exact:true})).toBeVisible();
  await page.route('**/api/recognition-model', r => r.fulfill({json:{model:null}}));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('请在设置中选择模型',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'上传并识别 →',exact:true})).toBeDisabled();
});
