import { test, expect, type Page } from '@playwright/test';

const savedAPI = { provider:'api',baseURL:'https://vendor.example/v1',apiKey:'',hasKey:true,model:'saved-vision',protocol:'responses',structured:true };
const option = (id: string, isDefault = false) => ({ id,name:`Server ${id}`,description:`Server description for ${id}`,isDefault,vision:true });

async function settings(page: Page, model: unknown = null) {
  await page.route('**/api/auth/state', route => route.fulfill({json:{authenticated:true,csrf:'test'}}));
  await page.route('**/api/catalog', route => route.fulfill({json:{accounts:[],categories:[],currency:'USD'}}));
  await page.route('**/api/recognition-model', route => route.fulfill({json:{model:null}}));
  await page.route('**/api/receipts?**', route => route.fulfill({json:[]}));
  for (const endpoint of ['passkeys','sessions','events']) {
    await page.route(`**/api/auth/${endpoint}`, route => route.fulfill({json:[]}));
  }
  await page.route('**/api/settings', route => route.fulfill({json:{model}}));
  await page.goto('/');
  await page.getByRole('button',{name:'设置',exact:true}).click();
}

test('loads the saved API catalog directly and preserves the saved selection', async ({page}) => {
  const requests: unknown[] = [];
  await page.route('**/api/settings/models', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({json:{models:[option('new-default',true),option('saved-vision')]}});
  });
  await settings(page,savedAPI);
  await expect(page.getByLabel('识别模型',{exact:true})).toHaveValue('saved-vision');
  await expect(page.locator('#model-description')).toHaveText('Server description for saved-vision');
  await expect(page.getByRole('button',{name:'保存识别设置',exact:true})).toBeEnabled();
  expect(requests).toEqual([{provider:'api',baseURL:savedAPI.baseURL,apiKey:''}]);
});

test('fetches new API credentials automatically and uses the server default', async ({page}) => {
  const requests: any[] = [];
  await page.route('**/api/settings/models', async route => {
    const input = route.request().postDataJSON(); requests.push(input);
    await route.fulfill({json:{models:input.provider === 'api' ? [option('future-release',true)] : []}});
  });
  await settings(page);
  await page.getByLabel('服务来源',{exact:true}).selectOption('api');
  await page.getByLabel('Base URL（包含 /v1 等服务路径）',{exact:true}).fill('https://new-vendor.example/v1');
  await page.getByLabel('API Key',{exact:true}).fill('new-private-key');
  await expect(page.getByLabel('识别模型',{exact:true})).toHaveValue('future-release');
  await expect(page.locator('#model-description')).toHaveText('Server description for future-release');
  expect(requests.filter(r => r.provider === 'api')).toEqual([{provider:'api',baseURL:'https://new-vendor.example/v1',apiKey:'new-private-key'}]);
});

test('refreshes from the server and requires a current model after removal or errors', async ({page}) => {
  let version = 0;
  await page.route('**/api/settings/models', async route => {
    version++;
    if (version === 3) return route.fulfill({status:502,json:{error:'模型服务暂时不可用'}});
    await route.fulfill({json:{models:[option(version === 1 ? 'saved-vision' : 'latest-release',true)]}});
  });
  await settings(page,savedAPI);
  const picker = page.getByLabel('识别模型',{exact:true}), save = page.getByRole('button',{name:'保存识别设置',exact:true});
  const refresh = page.getByRole('button',{name:'刷新模型列表',exact:true});
  await expect(save).toBeEnabled();
  await refresh.click();
  await expect(picker.locator('option[value="latest-release"]')).toHaveCount(1);
  await expect(picker.locator('option[value="saved-vision"]')).toBeDisabled();
  await expect(save).toBeDisabled();
  await picker.selectOption('latest-release');
  await expect(save).toBeEnabled();
  await refresh.click();
  await expect(page.getByRole('alert')).toHaveText('模型服务暂时不可用');
  await expect(picker).toBeDisabled();
  await expect(save).toBeDisabled();
  await refresh.click();
  await expect(save).toBeEnabled();
  await expect(picker).toHaveValue('latest-release');
});

test('keeps the current catalog when an older provider request finishes later', async ({page}) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let started = false;
  await page.route('**/api/settings/models', async route => {
    if (route.request().postDataJSON().provider === 'api') {
      started = true; await pending;
      await route.fulfill({json:{models:[option('stale-api-model',true)]}});
      finish();
    } else await route.fulfill({json:{models:[option('current-account-model',true)]}});
  });
  await settings(page,savedAPI);
  await expect.poll(() => started).toBe(true);
  await page.getByLabel('服务来源',{exact:true}).selectOption('codex');
  await expect(page.getByLabel('识别模型',{exact:true})).toHaveValue('current-account-model');
  release();
  await finished;
  await expect(page.getByLabel('识别模型',{exact:true}).locator('option[value="stale-api-model"]')).toHaveCount(0);
  await expect(page.locator('#model-description')).toHaveText('Server description for current-account-model');
});
