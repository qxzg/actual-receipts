import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export type Config = { origin: string; rpID: string; dataDir: string; key: Buffer; port: number; host: string; trustedProxy: string | false; providerUrl: string; providerToken: string; test?: boolean };
export function readSecret(path: string) { return readFileSync(path, 'utf8').trim(); }
export function loadConfig(): Config {
  const origin = process.env.APP_ORIGIN || 'http://localhost:3100'; const url = new URL(origin);
  const localHTTP = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.origin !== origin || (url.protocol !== 'https:' && !localHTTP)) throw new Error('APP_ORIGIN 必须为 HTTPS 来源或本机 HTTP 来源');
  const key = Buffer.from(readSecret(process.env.MASTER_KEY_FILE || 'secrets/master-key'), 'hex');
  if (key.length !== 32) throw new Error('主密钥必须为 32 字节十六进制字符串');
  return { origin, rpID: url.hostname, dataDir: resolve(process.env.DATA_DIR || 'data'), key,
    port: Number(process.env.PORT || 3100), host: process.env.HOST || '127.0.0.1',
    trustedProxy: process.env.TRUSTED_PROXY || false, providerUrl: process.env.PROVIDER_URL || 'http://codex-provider:3101',
    providerToken: readSecret(process.env.PROVIDER_TOKEN_FILE || 'secrets/provider-token') };
}
