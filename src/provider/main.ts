import Fastify from 'fastify';
import { readFileSync, mkdirSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { enrichmentInputSchema, enrichmentOutputSchema, enrichmentPrompt } from '../shared/enrichment.js';
import { CodexRPC } from './rpc.js';
import { listCodexModels } from './models.js';
import type { RecognitionStage } from '../shared/progress.js';
const token = readFileSync(process.env.PROVIDER_TOKEN_FILE || '/run/secrets/provider-token', 'utf8').trim();
if (token.length < 32) throw new Error('Internal token is too short');
mkdirSync(process.env.CODEX_HOME || '/data/codex', { recursive: true, mode: 0o700 });
const app = Fastify({ logger: false, bodyLimit: 34 * 1024 * 1024, requestTimeout: 250_000 });
let auth: CodexRPC | undefined, busy = false;
let progress: { id: string; stage: RecognitionStage; model: string } | null = null;
const progressID = z.object({ progressId: z.string().uuid().optional() });
const report = (stage: RecognitionStage) => { if (progress) progress.stage = stage; };
const getAuth = async () => { if (!auth) { auth = new CodexRPC(); const instance = auth; instance.once('closed', () => { if (auth === instance) auth = undefined; }); } await auth.ready; return auth; };
app.addHook('onRequest', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (req.url === '/healthz') return;
  const got = Buffer.from(req.headers.authorization || ''), wanted = Buffer.from(`Bearer ${token}`);
  if (got.length !== wanted.length || !timingSafeEqual(got, wanted)) return reply.code(401).send({ error: 'Unauthorized' });
});
app.setErrorHandler((_error, _req, reply) => reply.code(502).send({ error: 'Codex 授权或识别失败，请检查模型权限和额度' }));
app.get('/healthz', async () => ({ ok: true }));
app.post('/progress', async req => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.body);
  return { progress: progress?.id === id ? { stage: progress.stage, model: progress.model } : null };
});
app.get('/status', async () => { const rpc = await getAuth(); const account = await rpc.call('account/read', { refreshToken: true }); return { account: account.account, requiresOpenaiAuth: account.requiresOpenaiAuth, busy }; });
app.get('/models', async (_req, reply) => {
  const data = await listCodexModels();
  if (!data) return reply.code(401).send({ error: '请先完成 ChatGPT 授权' });
  return { data };
});
app.post('/login', async (_req, reply) => { if (busy) return reply.code(409).send({ error: '请等待识别完成' }); const rpc = await getAuth(); return rpc.call('account/login/start', { type: 'chatgptDeviceCode' }); });
app.post('/logout', async (_req, reply) => { if (busy) return reply.code(409).send({ error: '请等待识别完成' }); const rpc = await getAuth(); return rpc.call('account/logout', {}); });
app.post('/recognize', async (req, reply) => {
  if (busy) return reply.code(409).send({ error: '识别处理中，请稍后重试' });
  const input = z.object({ images: z.array(z.string().max(4_200_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)).min(1).max(8), prompt: z.string().max(200000), model: z.string().min(1).max(150), schema: z.record(z.string(), z.unknown()) }).parse(req.body);
  const { progressId } = progressID.parse(req.body);
  busy = true; const rpc = new CodexRPC();
  progress = progressId ? { id: progressId, stage: 'waiting', model: input.model } : null;
  try { return await rpc.recognize(input, report); } finally { progress = null; rpc.close(); busy = false; }
});
app.post('/enrich', async (req, reply) => {
  if (busy) return reply.code(409).send({ error: '商品查询处理中，请稍后重试' });
  const input = enrichmentInputSchema.parse(req.body);
  const { progressId } = progressID.parse(req.body);
  busy = true; const rpc = new CodexRPC(true);
  try {
    await rpc.ready;
    const account = await rpc.call('account/read', { refreshToken: false });
    if (!account.account) return reply.code(401).send({ error: '请先完成 ChatGPT 授权' });
    let model = input.model;
    if (!model) {
      const data: any[] = []; let cursor: string | undefined;
      do {
        const page = await rpc.call('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
        data.push(...page.data); cursor = page.nextCursor || undefined;
      } while (cursor && data.length < 500 && !data.some(m => m.isDefault));
      model = data.find(m => m.isDefault)?.model;
      if (!model) throw new Error('Codex 默认模型暂时不可用');
    }
    progress = progressId ? { id: progressId, stage: 'enriching', model } : null;
    return enrichmentOutputSchema.parse(await rpc.recognize({ images: [], model, prompt: enrichmentPrompt(input), schema: z.toJSONSchema(enrichmentOutputSchema, { target: 'draft-7' }) }, report));
  } finally { progress = null; rpc.close(); busy = false; }
});
const stop = async () => { auth?.close(); await app.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 3101) });
