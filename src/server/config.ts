import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export type Config = { origin: string; rpID: string; dataDir: string; key: Buffer; port: number; host: string; trustedProxy: string | false; providerUrl: string; providerToken: string; test?: boolean };
export function readSecret(path: string) { return readFileSync(path, 'utf8').trim(); }
export function loadConfig(): Config {
  const origin = process.env.APP_ORIGIN || 'https://receipts.hx-sun.com'; const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== 'https:') throw new Error('APP_ORIGIN 必须为明确的 HTTPS 来源');
  const key = Buffer.from(readSecret(process.env.MASTER_KEY_FILE || 'secrets/master-key'), 'hex');
  if (key.length !== 32) throw new Error('主密钥必须为 32 字节十六进制字符串');
  return { origin, rpID: url.hostname, dataDir: resolve(process.env.DATA_DIR || 'data'), key,
    port: Number(process.env.PORT || 3100), host: process.env.HOST || '127.0.0.1',
    trustedProxy: process.env.TRUSTED_PROXY || false, providerUrl: process.env.PROVIDER_URL || 'http://codex-provider:3101',
    providerToken: readSecret(process.env.PROVIDER_TOKEN_FILE || 'secrets/provider-token') };
}
