import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { z } from 'zod';
import type { Config } from './config.js';
import { Store, hash, token, now, id, fail } from './db.js';
export type Session = { hash: string; csrf: string; kind: 'anonymous' | 'bootstrap' | 'owner' | 'recovery'; expires: number; verified_at: number; created_at: number; label: string };
declare module 'fastify' { interface FastifyRequest { auth: Session | null } }
const cookie = '__Host-receipt';
const nameSchema = z.string().trim().min(1).max(80);
export function setupAuth(app: FastifyInstance, store: Store, config: Config) {
  app.addHook('onResponse', async (req, reply) => { if (req.url.startsWith('/api/auth/') && reply.statusCode >= 400) store.event(`auth.request.failed.${reply.statusCode}`); });
  const makeSession = (reply: FastifyReply, kind: Session['kind'], old?: Session | null) => {
    const t = token(), time = now(), age = kind === 'owner' ? 604800 : 900;
    const s: Session = { hash: hash(t), csrf: token(), kind, expires: time + age * 1000, verified_at: kind === 'owner' ? time : 0, created_at: time, label: '浏览器会话' };
    if (old) store.run('DELETE FROM sessions WHERE hash=?', old.hash);
    store.run('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)', s.hash, s.csrf, s.kind, s.expires, s.verified_at, s.created_at, s.label);
    reply.setCookie(cookie, t, { path: '/', secure: true, httpOnly: true, sameSite: 'lax', maxAge: age });
    return s;
  };
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store, private').header('Pragma', 'no-cache');
    const value = req.cookies[cookie];
    req.auth = value ? store.get<Session>('SELECT * FROM sessions WHERE hash=? AND expires>?', hash(value), now()) || null : null;
    if (!req.url.startsWith('/api/')) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers.origin !== config.origin) fail('请求来源校验失败', 403);
      if (!req.auth || req.headers['x-csrf-token'] !== req.auth.csrf) fail('请刷新页面后重试', 403);
    }
    if (!req.url.startsWith('/api/auth/')) owner(req);
  });
  const challenge = (session: Session, kind: string, value: string, context: unknown = {}) => {
    store.run('DELETE FROM challenges WHERE session_hash=? AND kind=?', session.hash, kind);
    const challengeId = id(); store.run('INSERT INTO challenges VALUES(?,?,?,?,?,?)', challengeId, session.hash, kind, value, JSON.stringify(context), now() + 300_000); return challengeId;
  };
  const active = (s: Session) => { if (!store.get('SELECT hash FROM sessions WHERE hash=? AND expires>? AND kind=?', s.hash, now(), s.kind)) fail('会话已过期', 401); };
  const authLimit = { rateLimit: { max: 15, timeWindow: '5 minutes' } };
  app.get('/api/auth/state', { config: authLimit }, async (req, reply) => {
    store.run('DELETE FROM sessions WHERE expires<?', now());
    store.run('DELETE FROM challenges WHERE expires<?', now());
    store.run('DELETE FROM recovery WHERE expires IS NOT NULL AND expires<?', now());
    const s = req.auth || makeSession(reply, 'anonymous');
    return { authenticated: s.kind === 'owner', mode: s.kind, initialized: !!store.get('SELECT id FROM owner'), csrf: s.csrf, recent: s.kind === 'owner' && s.verified_at > now() - 300_000 };
  });
  app.post('/api/auth/bootstrap', { config: authLimit }, async (req, reply) => {
    const { token: t } = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
    return store.tx(() => {
      if (store.get('SELECT id FROM owner')) fail('所有者已创建', 409);
      if (!store.get("DELETE FROM recovery WHERE hash=? AND kind='bootstrap' AND expires>? RETURNING hash", hash(t), now())) fail('初始化令牌无效或已过期');
      store.event('bootstrap.started'); const s = makeSession(reply, 'bootstrap', req.auth); return { csrf: s.csrf, mode: s.kind };
    });
  });
  app.post('/api/auth/recover', { config: authLimit }, async (req, reply) => {
    const { code } = z.object({ code: z.string().trim().min(20).max(200) }).parse(req.body);
    return store.tx(() => {
      if (!store.get('SELECT id FROM owner')) fail('请先初始化所有者');
      if (!store.get("DELETE FROM recovery WHERE hash=? AND kind IN ('code','admin') AND (expires IS NULL OR expires>?) RETURNING hash", hash(code), now())) { store.event('recovery.failed'); fail('恢复凭据无效或已使用'); }
      const s = makeSession(reply, 'recovery', req.auth); store.event('recovery.started'); return { csrf: s.csrf, mode: s.kind };
    });
  });
  app.post('/api/auth/register/options', { config: authLimit }, async (req) => {
    const s = req.auth!; if (!['owner', 'bootstrap', 'recovery'].includes(s.kind)) fail('请先登录或输入初始化令牌', 401);
    if (s.kind === 'owner') recent(req);
    const userID = store.get('SELECT user_id FROM owner')?.user_id || token();
    const options = await generateRegistrationOptions({ rpName: '小票账本', rpID: config.rpID,
      userName: 'owner', userDisplayName: '我的小票账本', userID: Buffer.from(userID, 'base64url'),
      attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: store.all('SELECT id,transports FROM passkeys').map(p => ({ id: p.id, transports: JSON.parse(p.transports) })),
    });
    return { options, challengeId: challenge(s, 'register', options.challenge, { userID, mode: s.kind }) };
  });
  app.post('/api/auth/register/verify', { config: authLimit }, async (req, reply) => {
    const { challengeId, response, name } = z.object({ challengeId: z.string(), response: z.any(), name: nameSchema }).parse(req.body);
    const s = req.auth!;
    if (s.kind === 'owner') recent(req);
    const c = store.consumeChallenge(s.hash, challengeId, 'register');
    if (c.context.mode !== s.kind || !['owner', 'bootstrap', 'recovery'].includes(s.kind)) fail('注册会话无效', 403);
    const result = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true });
    if (!result.verified || !result.registrationInfo) fail('Passkey 注册失败');
    const cred = result.registrationInfo.credential;
    return store.tx(() => {
      active(s);
      if (s.kind === 'bootstrap') {
        if (store.get('SELECT id FROM owner')) fail('所有者已创建', 409);
        store.run('INSERT INTO owner VALUES(1,?,?)', c.context.userID, now());
      }
      if (s.kind === 'recovery') { store.run('DELETE FROM passkeys'); store.run('DELETE FROM sessions'); store.run('DELETE FROM recovery'); store.run('DELETE FROM challenges'); }
      store.run('INSERT INTO passkeys VALUES(?,?,?,?,?,?,NULL)', cred.id, Buffer.from(cred.publicKey).toString('base64'), cred.counter, JSON.stringify(cred.transports || []), name, now());
      const codes = ['bootstrap', 'recovery'].includes(s.kind) ? store.codes() : undefined;
      if (s.kind === 'bootstrap') { store.run("DELETE FROM sessions WHERE kind='bootstrap'"); store.run("DELETE FROM recovery WHERE kind='bootstrap'"); }
      const next = makeSession(reply, 'owner', s); store.event(`passkey.registered.${s.kind}`);
      return { verified: true, csrf: next.csrf, recoveryCodes: codes };
    });
  });
  app.post('/api/auth/login/options', { config: authLimit }, async (req) => {
    if (!store.get('SELECT id FROM owner')) fail('请先初始化');
    if (!['anonymous', 'owner'].includes(req.auth!.kind)) fail('请完成当前恢复或初始化流程');
    const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'required' });
    return { options, challengeId: challenge(req.auth!, 'login', options.challenge) };
  });
  app.post('/api/auth/login/verify', { config: authLimit }, async (req, reply) => {
    const { challengeId, response } = z.object({ challengeId: z.string(), response: z.any() }).parse(req.body);
    const s = req.auth!, c = store.consumeChallenge(s.hash, challengeId, 'login');
    const key = store.get('SELECT * FROM passkeys WHERE id=?', String(response?.id || ''));
    if (!key) fail('Passkey 无效', 401);
    const ownerID = store.get('SELECT user_id FROM owner')?.user_id;
    if (response?.response?.userHandle && response.response.userHandle !== ownerID) fail('用户验证失败', 401);
    const result = await verifyAuthenticationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID,
      credential: { id: key.id, publicKey: Buffer.from(key.public_key, 'base64'), counter: key.counter, transports: JSON.parse(key.transports) }, requireUserVerification: true });
    if (!result.verified) fail('Passkey 验证失败', 401);
    return store.tx(() => {
      active(s);
      if (!store.run('UPDATE passkeys SET counter=?,used_at=? WHERE id=? AND counter=?', result.authenticationInfo.newCounter, now(), key.id, key.counter).changes) fail('Passkey 状态已更新，请重新验证', 409);
      const next = makeSession(reply, 'owner', s); store.event('login.success'); return { verified: true, csrf: next.csrf };
    });
  });
  app.post('/api/auth/logout', async (req, reply) => { store.run('DELETE FROM sessions WHERE hash=?', req.auth!.hash); reply.clearCookie(cookie, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' }); return { ok: true }; });
  app.get('/api/auth/passkeys', async (req) => { owner(req); return store.all('SELECT id,name,created_at,used_at FROM passkeys ORDER BY created_at'); });
  app.patch('/api/auth/passkeys/:id', async (req) => { recent(req); const name = nameSchema.parse((req.body as any)?.name); store.run('UPDATE passkeys SET name=? WHERE id=?', name, (req.params as any).id); store.event('passkey.renamed'); return { ok: true }; });
  app.delete('/api/auth/passkeys/:id', async (req) => {
    recent(req); store.tx(() => { if (store.get('SELECT count(*) AS n FROM passkeys')!.n <= 1) fail('请至少保留一把 Passkey'); store.run('DELETE FROM passkeys WHERE id=?', (req.params as any).id); store.event('passkey.revoked'); }); return { ok: true };
  });
  app.post('/api/auth/recovery-codes', async (req) => { recent(req); return store.tx(() => { store.event('recovery-codes.rotated'); return { recoveryCodes: store.codes() }; }); });
  app.get('/api/auth/sessions', async (req) => { owner(req); return store.all('SELECT hash,created_at,expires,label FROM sessions WHERE kind=\'owner\' AND expires>?', now()).map(s => ({ id: s.hash, created_at: s.created_at, expires: s.expires, label: s.label, current: s.hash === req.auth!.hash })); });
  app.delete('/api/auth/sessions/:id', async (req) => { owner(req); store.run('DELETE FROM sessions WHERE hash=?', (req.params as any).id); return { ok: true }; });
  app.post('/api/auth/logout-all', async (req, reply) => { owner(req); store.run('DELETE FROM sessions'); store.event('sessions.revoked'); reply.clearCookie(cookie, { path: '/', secure: true, httpOnly: true, sameSite: 'lax' }); return { ok: true }; });
  app.get('/api/auth/events', async (req) => { owner(req); return store.all('SELECT event,at FROM auth_events ORDER BY id DESC LIMIT 100'); });
}
export function owner(req: FastifyRequest) { if (req.auth?.kind !== 'owner') fail('请使用 Passkey 登录', 401); }
export function recent(req: FastifyRequest) { owner(req); if (req.auth!.verified_at < now() - 300_000) fail('请先完成一次 Passkey 验证，再修改安全设置', 428); }
