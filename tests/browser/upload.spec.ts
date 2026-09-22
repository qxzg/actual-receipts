import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { allocate, emptyDraft, type Receipt } from '../../src/shared/receipt';

const model = { provider: 'codex', model: 'gpt-6-astra' };
const draft = emptyDraft('USD', 'bank');
const receipt = (): Receipt => ({ id:'receipt-one',version:1,status:'draft',draft:structuredClone(draft),images:[],created_at:Date.now(),updated_at:Date.now(),error:null,cleanup:'retained',transaction_id:null,submission_id:'submission',allocation:allocate(draft) });
const photo = async (name = 'receipt-top.png') => ({ name,mimeType:'image/png',buffer:await sharp(Buffer.from('<svg width="480" height="760"><rect width="480" height="760" fill="#fffdf7"/><text x="45" y="85" font-family="monospace" font-size="28">NEIGHBORHOOD MARKET</text><path d="M45 115H435M45 430H435" stroke="#333" stroke-dasharray="5 5"/><text x="45" y="180" font-size="22">MILK                 7.98</text><text x="45" y="240" font-size="22">TOWEL                4.99</text><text x="45" y="300" font-size="22">DISCOUNT            -1.00</text><text x="45" y="360" font-size="22">TAX                   .99</text><text x="45" y="500" font-size="28">TOTAL     $12.96</text><text x="110" y="650" font-size="20">THANK YOU</text></svg>')).png().toBuffer() });
async function home(page: Page, defaultAccount?: string) {
  await page.route('**/api/auth/state', r => r.fulfill({json:{authenticated:true,csrf:'test'}}));
  await page.route('**/api/catalog', r => r.fulfill({json:{accounts:[{id:'bank',name:'日常银行卡'}],categories:[],currency:'USD',defaultAccount}}));
  await page.route('**/api/recognition-model', r => r.fulfill({json:{model}}));
  await page.route('**/api/receipts?**', r => r.fulfill({json:[]}));
  await page.goto('/');
  await expect(page.getByText(model.model,{exact:true})).toBeVisible();
}

type PastedFile = { name: string; mimeType: string; buffer?: Buffer; size?: number };
async function paste(page: Page, files: PastedFile[], target = 'body', text = '') {
  return page.evaluate(({ files, target, text }) => {
    const clipboardData = new DataTransfer();
    if (text) clipboardData.setData('text/plain', text);
    for (const file of files) {
      const bytes = file.size === undefined ? Uint8Array.from(atob(file.base64), char => char.charCodeAt(0)) : new Uint8Array(file.size);
      clipboardData.items.add(new File([bytes], file.name, { type: file.mimeType }));
    }
    const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true });
    document.querySelector(target)!.dispatchEvent(event);
    return event.defaultPrevented;
  }, { files: files.map(({ buffer, ...file }) => ({ ...file, base64: buffer?.toString('base64') || '' })), target, text });
}

test('pastes photos in order alongside selected files and keeps photo actions available', async ({page}) => {
  await home(page);
  await page.getByLabel('付款账户', {exact:true}).selectOption('bank');
  await expect(page.getByText('支持 Ctrl+V / ⌘V 粘贴图片')).toBeVisible();
  expect(await paste(page, [await photo('first.png')])).toBe(true);
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await paste(page, [await photo('second.png'), await photo('third.png')], 'body', 'copied image');
  await expect(page.locator('.photo-caption strong')).toHaveText(['first.png', 'second.png', 'third.png']);
  await page.getByLabel('小票图片', {exact:true}).setInputFiles(await photo('picked.png'));
  await paste(page, [await photo('')]);
  await expect(page.locator('.photo-card')).toHaveCount(5);
  await expect(page.locator('.photo-caption strong').last()).toHaveText(/^clipboard-.*\.png$/);
  await expect(page.getByText('支持 Ctrl+V / ⌘V 粘贴图片')).toBeVisible();
  await page.getByRole('button', {name:'查看第 1 张照片'}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await paste(page, [await photo('paused.png')], '.photo-dialog button')).toBe(false);
  await expect(page.locator('.photo-card')).toHaveCount(5);
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name:'将第 2 张照片前移'}).click();
  await expect(page.locator('.photo-caption strong').first()).toHaveText('second.png');
  await page.getByRole('button', {name:'删除第 1 张照片'}).click();
  await expect(page.locator('.photo-card')).toHaveCount(4);
  await page.getByLabel('替换第 1 张照片').setInputFiles(await photo('replacement.png'));
  await expect(page.locator('.photo-caption strong').first()).toHaveText('replacement.png');
  await expect(page.getByRole('button', {name:'上传并识别 →',exact:true})).toBeEnabled();
});

test('validates pasted image batches and preserves the existing selection', async ({page}) => {
  await home(page);
  const first = await photo();
  await paste(page, [first]);
  for (const invalid of [
    {name:'large.png',mimeType:'image/png',size:15*1024*1024+1},
    {name:'empty.png',mimeType:'image/png',size:0},
    {name:'unsupported.gif',mimeType:'image/gif',size:1},
  ]) {
    await paste(page, [first, invalid]);
    await expect(page.getByRole('alert')).toContainText(invalid.name);
    await expect(page.locator('.photo-card')).toHaveCount(1);
  }
  await paste(page, Array.from({length:8}, () => first));
  await expect(page.getByRole('alert')).toContainText('最多选择 8 张');
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await paste(page, Array.from({length:7}, () => first));
  await expect(page.locator('.photo-card')).toHaveCount(8);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await paste(page, [first]);
  await expect(page.getByRole('alert')).toContainText('最多选择 8 张');
  await expect(page.locator('.photo-card')).toHaveCount(8);
});

test('preserves editable fields and text paste, and cleans up when leaving the upload page', async ({page}) => {
  await home(page);
  const first = await photo();
  expect(await paste(page, [], 'body', 'https://example.com/receipt.png')).toBe(false);
  expect(await paste(page, [{name:'document.pdf',mimeType:'application/pdf',size:10}])).toBe(false);
  expect(await paste(page, [first], 'input[aria-label="搜索商家或商品"]', 'merchant')).toBe(false);
  await page.evaluate(() => {
    const editor = document.createElement('div'); editor.contentEditable = 'true'; editor.id = 'paste-editor';
    editor.innerHTML = '<span>Editable</span>'; document.body.append(editor);
    const textarea = document.createElement('textarea'); document.body.append(textarea);
  });
  expect(await paste(page, [first], '#paste-editor span')).toBe(false);
  expect(await paste(page, [first], 'textarea')).toBe(false);
  await expect(page.locator('.photo-card')).toHaveCount(0);
  await page.getByRole('button', {name:'历史',exact:true}).click();
  expect(await paste(page, [first])).toBe(false);
  await page.getByRole('button', {name:'小票',exact:true}).click();
  await expect(page.getByText(model.model,{exact:true})).toBeVisible();
  await paste(page, [first]);
  await expect(page.locator('.photo-card')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name:'历史',exact:true}).click();
  expect(await paste(page, [first])).toBe(false);
  await page.getByRole('button', {name:'小票',exact:true}).click();
  await expect(page.getByText(model.model,{exact:true})).toBeVisible();
  await paste(page, [first]);
  await expect(page.locator('.photo-card')).toHaveCount(1);
});

test('pastes a real clipboard screenshot with the keyboard and uploads it once', async ({page, context}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await home(page);
  await page.getByLabel('付款账户', {exact:true}).selectOption('bank');
  await page.evaluate(() => navigator.clipboard.writeText('粘贴搜索文字'));
  await page.getByLabel('搜索商家或商品').focus();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(page.getByLabel('搜索商家或商品')).toHaveValue('粘贴搜索文字');
  const screenshot = await page.getByRole('region', {name:'添加小票'}).screenshot();
  await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([bytes], {type:'image/png'})})]);
  }, screenshot.toString('base64'));
  await page.getByRole('heading', {name:'添加一张小票'}).click();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(page.locator('.photo-card')).toHaveCount(1);
  await expect(page.locator('.photo-preview img')).toHaveJSProperty('naturalWidth',  screenshot.readUInt32BE(16));
  await page.screenshot({path:'artifacts/upload-clipboard-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path:'artifacts/upload-clipboard-mobile.png',fullPage:true});

  const current = receipt(); let uploads = 0, starts = 0;
  let finishUpload!: () => void;
  const uploadPending = new Promise<void>(resolve => { finishUpload = resolve; });
  await page.route('**/api/receipts?**', async route => {
    if (route.request().method() === 'GET') return route.fulfill({json:[]});
    uploads++;
    const form = await new Response(new Uint8Array(route.request().postDataBuffer()!), {
      headers: {'content-type':route.request().headers()['content-type']},
    }).formData();
    const uploaded = form.get('images') as File;
    expect(uploaded.type).toBe('image/png');
    // Chromium re-encodes clipboard PNGs; compare decoded pixels rather than PNG compression.
    expect(await sharp(Buffer.from(await uploaded.arrayBuffer())).ensureAlpha().raw().toBuffer())
      .toEqual(await sharp(screenshot).ensureAlpha().raw().toBuffer());
    await uploadPending;
    current.images = [{id:'clipboard-image',position:0}];
    await route.fulfill({json:current});
  });
  await page.route('**/api/receipts/receipt-one', route => route.fulfill({json:current}));
  await page.route('**/api/images/*', route => route.fulfill({contentType:'image/png',body:screenshot}));
  await page.route('**/api/receipts/receipt-one/recognize', route => {
    starts++; current.status = 'queued'; return route.fulfill({json:{jobId:'clipboard-job'}});
  });
  await page.getByRole('button', {name:'上传并识别 →',exact:true}).click();
  await expect(page.getByRole('button', {name:'处理中…',exact:true})).toBeDisabled();
  try {
    expect(await paste(page, [await photo('during-upload.png')])).toBe(false);
    await expect(page.locator('.photo-card')).toHaveCount(1);
  } finally { finishUpload(); }
  await expect(page.getByRole('status').filter({hasText:'等待识别'})).toBeVisible();
  expect(uploads).toBe(1); expect(starts).toBe(1);
});

test('preselects the last account from the current ledger', async ({page}) => {
  await home(page, 'bank');
  await expect(page.getByLabel('付款账户',{exact:true})).toHaveValue('bank');
});

test('uploads HEIC when Chromium needs a file placeholder for preview', async ({page}) => {
  await home(page);
  const heic=readFileSync(new URL('../fixtures/synthetic.heic',import.meta.url));
  const current=receipt(); let uploads=0;
  await page.route('**/api/receipts?**',async route=>{
    if(route.request().method()==='GET') return route.fulfill({json:[]});
    uploads++;
    const form=await new Response(new Uint8Array(route.request().postDataBuffer()!),{headers:{'content-type':route.request().headers()['content-type']}}).formData();
    const uploaded=form.get('images') as File;
    expect(uploaded.name).toBe('IMG_3275.HEIC');
    expect(uploaded.type).toBe('image/heic');
    expect(Buffer.from(await uploaded.arrayBuffer())).toEqual(heic);
    current.images=[{id:'heic-image',position:0}];
    await route.fulfill({json:current});
  });
  await page.route('**/api/receipts/receipt-one',route=>route.fulfill({json:current}));
  await page.route('**/api/images/*',async route=>route.fulfill({contentType:'image/png',body:(await photo()).buffer}));
  await page.route('**/api/receipts/receipt-one/recognize',route=>{current.status='queued';return route.fulfill({json:{jobId:'heic-job'}});});
  await page.getByLabel('小票图片',{exact:true}).setInputFiles({name:'IMG_3275.HEIC',mimeType:'image/heic',buffer:heic});
  await expect(page.locator('.photo-preview .photo-placeholder')).toBeVisible();
  await page.getByRole('button',{name:'查看第 1 张照片'}).click();
  await expect(page.getByRole('dialog',{name:'小票照片预览'})).toContainText('上传后可在核对页查看图片');
  await page.keyboard.press('Escape');
  await page.getByLabel('付款账户',{exact:true}).selectOption('bank');
  await page.getByRole('button',{name:'上传并识别 →',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'等待识别'})).toBeVisible();
  expect(uploads).toBe(1);
});

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
  await expect(page.getByRole('alert')).toContainText('JPG、PNG、WebP 或 HEIC');
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
