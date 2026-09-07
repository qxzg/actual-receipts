import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/server/config';

let dir: string;
const managed = ['APP_ORIGIN', 'MASTER_KEY_FILE', 'PROVIDER_TOKEN_FILE'] as const;
const original = Object.fromEntries(managed.map(key => [key, process.env[key]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'receipt-config-'));
  const master = join(dir, 'master-key');
  const provider = join(dir, 'provider-token');
  writeFileSync(master, '11'.repeat(32));
  writeFileSync(provider, '22'.repeat(32));
  process.env.MASTER_KEY_FILE = master;
  process.env.PROVIDER_TOKEN_FILE = provider;
  delete process.env.APP_ORIGIN;
});

afterEach(() => {
  for (const key of managed) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('public origin configuration', () => {
  it('defaults to localhost HTTP', () => {
    const config = loadConfig();
    expect(config.origin).toBe('http://localhost:3100');
    expect(config.rpID).toBe('localhost');
  });

  it('accepts an exact HTTPS origin', () => {
    process.env.APP_ORIGIN = 'https://receipts.example.com';
    expect(loadConfig().origin).toBe('https://receipts.example.com');
  });

  it.each(['http://receipts.example.com', 'https://receipts.example.com/path'])('rejects unsafe or non-origin value %s', origin => {
    process.env.APP_ORIGIN = origin;
    expect(() => loadConfig()).toThrow('APP_ORIGIN');
  });
});
