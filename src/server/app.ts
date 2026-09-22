import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import { existsSync, createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import { visionTestImage } from './vision-test.js';
import { Store, id, now, fail } from './db.js';
import type { Config } from './config.js';
import { setupAuth, recent } from './auth.js';
import { ActualBridge, actualSettingsSchema, type ActualSettings } from './actual.js';
import { modelSettingsSchema, Recognizer, providerCall, apiRecognize, withRecognition, listAPIModels, normalizeModels, type ModelSettings } from './models.js';
import { ReceiptService, safeError } from './service.js';
import { saveImage, removeOrphanImages } from './images.js';
import { draftSchema, emptyDraft } from '../shared/receipt.js';
export async function createApp(config: Config, overrides: { store?: Store; actual?: ActualBridge; recognizer?: Recognizer; workers?: boolean } = {}) {
  const app = Fastify({ logger: false, trustProxy: config.trustedProxy, bodyLimit: 1024 * 1024, requestTimeout: 300_000 });
  const store = overrides.store || new Store(config.dataDir, config.key);
  const actual = overrides.actual || new ActualBridge(store), recognizer = overrides.recognizer || new Recognizer(store, config);
  const service = new ReceiptService(store, actual, recognizer, config.key);
  await app.register(cookie);
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'blob:', 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'self'"] } }, crossOriginEmbedderPolicy: false });
  await app.register(rateLimit, { global: true, max: 240, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 8, fields: 2, parts: 10 } });
  setupAuth(app, store, config);
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: '输入字段格式有误，请检查日期、金额和必填字段', fields: error.issues.map(i => i.path.join('.')) });
    if (error.code?.startsWith('FST_REQ_FILE_TOO_LARGE') || error.statusCode === 413) return reply.code(413).send({ error: '每张图片上限为 15 MiB，每张小票最多 8 张图片' });
    const status = error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
    reply.code(status).send({ error: status === 429 ? '操作较频繁，请稍后重试' : safeError(error) });
  });
  app.get('/healthz', async () => { store.get('SELECT 1'); return { ok: true }; });
  app.get('/api/catalog', async () => {
    const catalog = await actual.catalog(), connection = actual.connection();
    const preferred = store.setting<string>(`last-account:${connection}`);
    return { ...catalog, defaultAccount: preferred && catalog.accounts.some(account => account.id === preferred) ? preferred : undefined };
  });
  app.get('/api/recognition-model', async () => {
    const settings = store.setting<ModelSettings>('model');
    return { model: settings ? { provider: settings.provider, model: settings.model } : null };
  });
  app.get('/api/settings', async () => {
    const a = store.setting<ActualSettings>('actual'), m = store.setting<ModelSettings>('model');
    return { actual: a ? { ...a, password: '', budgetPassword: '', hasPassword: !!a.password, hasBudgetPassword: !!a.budgetPassword } : null,
      model: m ? { ...m, apiKey: '', hasKey: !!m.apiKey } : null,
      otherLedgerReceiptCount: a ? service.otherLedgerReceiptCount(actual.connection(a)) : 0 };
  });
  const actualInput = (body: unknown) => {
    const a = actualSettingsSchema.parse(body), prev = store.setting<ActualSettings>('actual');
    const url = new URL(a.serverURL);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === 'actual')) fail('Actual 地址请使用 HTTPS 或私有网络中的 http://actual:5006');
    a.serverURL = url.href.replace(/\/$/, '');
    if (prev && prev.serverURL === a.serverURL) a.password ||= prev.password;
    if (prev && prev.syncId === a.syncId) a.budgetPassword ||= prev.budgetPassword;
    return a;
  };
  app.post('/api/settings/actual/test', async (req) => { recent(req); return actual.call('probe', {}, actualInput(req.body)); });
  app.put('/api/settings/actual', async (req) => {
    recent(req); const input = actualInput(req.body);
    const pending = store.get("SELECT id FROM submissions WHERE status!='synced' LIMIT 1");
    const previous = store.setting<ActualSettings>('actual');
    if (pending && previous && (actual.connection(previous) !== actual.connection(input) || previous.currency !== input.currency)) fail('请完成待核验提交后再切换账本或币种', 409);
    store.setSetting('actual', input); store.event('settings.actual.changed'); return { ok: true };
  });
  app.post('/api/settings/models', async (req) => {
    const body = z.object({provider:z.enum(['api','codex']),baseURL:z.string().max(500).optional(),apiKey:z.string().max(4000).optional()}).parse(req.body);
    if (body.provider === 'codex') return {models:normalizeModels(await providerCall(config,'/models'),'codex')};
    recent(req);
    const saved = store.setting<ModelSettings>('model');
    const baseURL = body.baseURL || '';
    const apiKey = body.apiKey || (saved?.baseURL === baseURL ? saved.apiKey : '');
    if (!baseURL || !apiKey) fail('请先填写 API 地址和密钥，再获取模型列表');
    return {models:await listAPIModels(baseURL,apiKey)};
  });
  app.put('/api/settings/model', async (req) => {
    recent(req); const input = modelSettingsSchema.parse(req.body), previous = store.setting<ModelSettings>('model');
    if (input.provider === 'api') {
      const url = new URL(input.baseURL); if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('模型地址请使用 HTTPS');
      if (previous?.baseURL === input.baseURL) input.apiKey ||= previous.apiKey;
      if (!input.apiKey) fail('请填写 API Key');
    }
    store.setSetting('model', input); store.event('settings.model.changed'); return { ok: true };
  });
  app.post('/api/settings/model/test', async (req) => {
    recent(req); const settings = store.setting<ModelSettings>('model'); if (!settings) fail('请先保存模型设置');
    return withRecognition(async () => {
    const png = await visionTestImage();
    const images = [`data:image/png;base64,${png.toString('base64')}`], prompt = 'Read the six digits in this image. Return JSON {"digits":"..."}.', schema = { type: 'object', properties: { digits: { type: 'string' } }, required: ['digits'], additionalProperties: false };
    const result = settings.provider === 'codex' ? await providerCall(config, '/recognize', { images, prompt, model: settings.model, schema }) : await apiRecognize(settings, images, prompt, schema);
    if (result.digits !== '739251') fail('图片读取测试结果有差异，请确认模型支持图片', 422);
    return { ok: true, message: '图片读取测试通过' };
    });
  });
  app.get('/api/settings/chatgpt', async () => providerCall(config, '/status'));
  app.post('/api/settings/chatgpt/login', async (req) => { recent(req); store.event('chatgpt.login.started'); return providerCall(config, '/login', {}); });
  app.post('/api/settings/chatgpt/logout', async (req) => { recent(req); store.event('chatgpt.logout'); return providerCall(config, '/logout', {}); });
  let uploading = false;
  app.post('/api/receipts', async (req, reply) => {
    if (uploading) fail('正在处理上传，请稍后重试', 429);
    const query = z.object({ account: z.string().max(100).default(''), receiptId: z.string().uuid().optional(), version: z.coerce.number().int().optional() }).parse(req.query);
    const existing = query.receiptId ? service.receipt(query.receiptId) : undefined;
    const uploadConnection = store.setting<ActualSettings>('actual') ? actual.connection() : null;
    if (existing && (!['draft', 'failed'].includes(existing.status) || existing.version !== query.version || store.get('SELECT id FROM submissions WHERE receipt_id=?', existing.id))) fail('草稿已更新或正在处理，请刷新后重试', 409);
    const startPosition = existing?.images.length || 0;
    if (startPosition >= 8) fail('每张小票最多 8 张图片', 413);
    const receiptID = existing?.id || id(), time = now(); uploading = true;
    if (existing) store.run("UPDATE receipts SET status='uploading' WHERE id=?", receiptID);
    else store.run("INSERT INTO receipts(id,status,draft,created_at,updated_at,submission_id) VALUES(?,'uploading',?,?,?,?)", receiptID, JSON.stringify(emptyDraft(store.setting<ActualSettings>('actual')?.currency || 'USD', query.account)), time, time, id());
    const added: Awaited<ReturnType<typeof saveImage>>[] = [];
    try {
      let position = startPosition;
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        if (position >= 8) fail('每张小票最多 8 张图片', 413);
        const image = await saveImage(part, join(store.dir, 'images', receiptID), position++); added.push(image);
        store.run('INSERT INTO images VALUES(?,?,?,?,?)', image.id, receiptID, image.position, image.path, image.thumbnail);
      }
      if (position === startPosition) fail('请选择小票图片');
      store.run("UPDATE receipts SET status='draft',error=NULL,version=version+?,updated_at=? WHERE id=?", existing ? 1 : 0, now(), receiptID);
      if (!existing && uploadConnection && query.account) store.setSetting(`last-account:${uploadConnection}`, query.account);
      return reply.code(201).send(service.receipt(receiptID));
    } catch (e) {
      if (existing) {
        for (const image of added) { await rm(image.path, { force: true }).catch(() => {}); await rm(image.thumbnail, { force: true }).catch(() => {}); store.run('DELETE FROM images WHERE id=?', image.id); }
        store.run("UPDATE receipts SET status='draft',error='后续图片上传失败，原有图片已保留' WHERE id=?", receiptID);
      } else store.tx(() => { store.run("UPDATE receipts SET status='deleting',cleanup='pending' WHERE id=?", receiptID); store.run('INSERT OR REPLACE INTO cleanup_queue(receipt_id,next_at,remove_record) VALUES(?,?,1)', receiptID, now()); });
      throw e;
    } finally { uploading = false; }
  });
  app.get('/api/receipts', async (req) => {
    const q = z.object({ keyword: z.string().max(200).default(''), from: z.string().max(10).default(''), to: z.string().max(10).default(''), status: z.string().max(30).default(''), ledger: z.enum(['all', 'current']).default('all'), offset: z.coerce.number().int().min(0).max(100000).default(0) }).parse(req.query);
    const clauses = ["status!='deleting'"], args: any[] = [];
    if (q.ledger === 'current') { clauses.push('(NOT EXISTS (SELECT 1 FROM submissions WHERE submissions.receipt_id=receipts.id) OR EXISTS (SELECT 1 FROM submissions WHERE submissions.receipt_id=receipts.id AND submissions.connection=?))'); args.push(actual.connection()); }
    if (q.keyword) { clauses.push("(instr(lower(json_extract(draft,'$.merchant')),lower(?))>0 OR EXISTS(SELECT 1 FROM json_each(json_extract(receipts.draft,'$.items')) WHERE instr(lower(json_extract(value,'$.name')),lower(?))>0))"); args.push(q.keyword, q.keyword); }
    if (q.from) { clauses.push("json_extract(draft,'$.date')>=?"); args.push(q.from); }
    if (q.to) { clauses.push("json_extract(draft,'$.date')<=?"); args.push(q.to); }
    if (q.status) { clauses.push('status=?'); args.push(q.status); }
    return store.all(`SELECT id,version,status,created_at,updated_at,error,cleanup,transaction_id,json_extract(draft,'$.merchant') AS merchant,json_extract(draft,'$.date') AS date,json_extract(draft,'$.total') AS total,json_extract(draft,'$.currency') AS currency FROM receipts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 50 OFFSET ?`, ...args, q.offset);
  });
  app.post('/api/receipts/purge-old-ledgers', async (req) => {
    recent(req); z.object({ confirmed: z.literal(true) }).parse(req.body); return service.purgeOtherLedgers();
  });
  app.get('/api/receipts/:id', async (req) => service.receipt((req.params as any).id));
  app.put('/api/receipts/:id', async (req) => { const body = z.object({ version: z.number().int(), draft: draftSchema }).parse(req.body); return service.save((req.params as any).id, body.version, body.draft); });
  app.post('/api/receipts/:id/recognize', async (req) => { const body = z.object({ version: z.number().int(), replace: z.boolean() }).parse(req.body); return service.enqueueRecognition((req.params as any).id, body.version, body.replace); });
  app.post('/api/receipts/:id/duplicates', async (req) => { const body = z.object({ version: z.number().int() }).parse(req.body); return service.duplicates((req.params as any).id, body.version); });
  app.post('/api/receipts/:id/submit', async (req, reply) => { const body = z.object({ version: z.number().int(), submissionId: z.string().uuid(), duplicateToken: z.string().max(100).optional() }).parse(req.body); return reply.code(202).send(await service.submit((req.params as any).id, body.version, body.submissionId, body.duplicateToken)); });
  app.post('/api/receipts/:id/verify', async (req) => service.verify((req.params as any).id));
  app.post('/api/receipts/:id/retry-submit', async (req) => { z.object({ confirmed: z.literal(true) }).parse(req.body); return service.retrySubmission((req.params as any).id); });
  app.post('/api/receipts/:id/cleanup', async (req) => { const r = service.receipt((req.params as any).id); if (r.status !== 'posted') fail('入账后可清理图片'); store.run('INSERT OR REPLACE INTO cleanup_queue(receipt_id,next_at) VALUES(?,?)', r.id, now()); return { ok: true }; });
  app.delete('/api/receipts/:id', async (req) => {
    const r = service.receipt((req.params as any).id);
    if (!['draft', 'failed'].includes(r.status) || store.get('SELECT id FROM submissions WHERE receipt_id=?', r.id)) fail('处理中或已有提交的小票需要保留记录', 409);
    store.tx(() => { store.run("UPDATE receipts SET status='deleting',cleanup='pending' WHERE id=?", r.id); store.run('INSERT OR REPLACE INTO cleanup_queue(receipt_id,next_at,remove_record) VALUES(?,?,1)', r.id, now()); }); return { ok: true };
  });
  app.get('/api/images/:id', async (req, reply) => {
    const image = store.get('SELECT images.* FROM images JOIN receipts ON receipts.id=images.receipt_id WHERE images.id=? AND receipts.status!=\'deleting\'', (req.params as any).id); if (!image) fail('图片已清理或不存在', 404);
    const original = (req.query as any).original === '1', path = original || !existsSync(image.thumbnail) ? image.path : image.thumbnail;
    if (!existsSync(path)) fail('图片已清理', 404);
    const meta = await sharp(path).metadata(); reply.type(meta.format === 'jpeg' ? 'image/jpeg' : `image/${meta.format}`);
    reply.header('Content-Disposition', 'inline'); return reply.send(createReadStream(path));
  });
  const publicDir = resolve('dist/public');
  if (existsSync(publicDir)) { await app.register(serveStatic, { root: publicDir, wildcard: false }); app.setNotFoundHandler((req, reply) => req.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html')); }
  if (overrides.workers !== false) { service.recover(); await removeOrphanImages(store); const timer = setInterval(() => void service.tick(), 1500); timer.unref(); app.addHook('onClose', async () => { clearInterval(timer); }); }
  return { app, store, service };
}
