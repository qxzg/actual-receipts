import Fastify from 'fastify';
import { readFileSync, mkdirSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { CodexRPC } from './rpc.js';
const token = readFileSync(process.env.PROVIDER_TOKEN_FILE || '/run/secrets/provider-token', 'utf8').trim();
if (token.length < 32) throw new Error('Internal token is too short');
mkdirSync(process.env.CODEX_HOME || '/data/codex', { recursive: true, mode: 0o700 });
const app = Fastify({ logger: false, bodyLimit: 34 * 1024 * 1024, requestTimeout: 250_000 });
let auth: CodexRPC | undefined, busy = false;
const getAuth = async () => { if (!auth) { auth = new CodexRPC(); const instance = auth; instance.once('closed', () => { if (auth === instance) auth = undefined; }); } await auth.ready; return auth; };
app.addHook('onRequest', async (req, reply) => {
  reply.header('Cache-Control', 'no-store');
  if (req.url === '/healthz') return;
  const got = Buffer.from(req.headers.authorization || ''), wanted = Buffer.from(`Bearer ${token}`);
  if (got.length !== wanted.length || !timingSafeEqual(got, wanted)) return reply.code(401).send({ error: 'Unauthorized' });
});
app.setErrorHandler((_error, _req, reply) => reply.code(502).send({ error: 'Codex 授权或识别失败，请检查模型权限和额度' }));
app.get('/healthz', async () => ({ ok: true }));
app.get('/status', async () => { const rpc = await getAuth(); const account = await rpc.call('account/read', { refreshToken: true }); return { account: account.account, requiresOpenaiAuth: account.requiresOpenaiAuth, busy }; });
app.get('/models', async (_req, reply) => {
  const rpc = await getAuth();
  const account = await rpc.call('account/read', { refreshToken: false });
  if (!account.account) return reply.code(401).send({ error: '请先完成 ChatGPT 授权' });
  const data: any[] = []; let cursor: string | undefined;
  do {
    const page = await rpc.call('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
    data.push(...page.data); cursor = page.nextCursor || undefined;
  } while (cursor && data.length < 500);
  return { data: data.slice(0, 500).map(m => ({ id: m.model, name: m.displayName, isDefault: !!m.isDefault, inputModalities: m.inputModalities || null })) };
});
app.post('/login', async (_req, reply) => { if (busy) return reply.code(409).send({ error: '请等待识别完成' }); const rpc = await getAuth(); return rpc.call('account/login/start', { type: 'chatgptDeviceCode' }); });
app.post('/logout', async (_req, reply) => { if (busy) return reply.code(409).send({ error: '请等待识别完成' }); const rpc = await getAuth(); return rpc.call('account/logout', {}); });
app.post('/recognize', async (req, reply) => {
  if (busy) return reply.code(409).send({ error: '识别处理中，请稍后重试' });
  const input = z.object({ images: z.array(z.string().max(4_200_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)).min(1).max(8), prompt: z.string().max(200000), model: z.string().min(1).max(150), schema: z.record(z.string(), z.unknown()) }).parse(req.body);
  busy = true; const rpc = new CodexRPC();
  try { return await rpc.recognize(input); } finally { rpc.close(); busy = false; }
});
const stop = async () => { auth?.close(); await app.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT || 3101) });
