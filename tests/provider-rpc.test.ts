import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { CodexRPC } from '../src/provider/rpc';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
let calls: any[], output: any, actions: any[];
const url = 'https://www.coca-cola.com/us/en/brands/diet-coke';
const send = (value: unknown) => child.stdout.write(JSON.stringify(value) + '\n');
beforeEach(() => {
  calls = []; actions = [];
  output = { items: [{ id: 'coke', name: 'Diet Coke', status: 'matched', sources: [{ title: 'Product', url }] }] };
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  vi.mocked(spawn).mockReturnValue(child as any);
  child.stdin.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const message = JSON.parse(line); calls.push(message);
      if (message.method === 'initialize') queueMicrotask(() => send({ id: message.id, result: {} }));
      if (message.method === 'thread/start') queueMicrotask(() => send({ id: message.id, result: { thread: { id: 'thread' } } }));
      if (message.method === 'turn/start') queueMicrotask(() => {
        send({ id: message.id, result: {} });
        for (const action of actions) send({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'webSearch', action } } });
        send({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', text: JSON.stringify(output) } } });
        send({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
      });
    }
  });
});
afterEach(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); vi.clearAllMocks(); });
const input = { images: [], prompt: 'Product lookup', model: 'chosen', schema: {} };

describe('isolated Codex search', () => {
  it('enables live search only for enrichment and preserves read-only permissions', async () => {
    actions = [{ type: 'openPage', url }];
    const rpc = new CodexRPC(true);
    try {
      const result = await rpc.recognize(input);
      expect(result.items[0].sources).toHaveLength(1);
      expect(vi.mocked(spawn).mock.calls[0][1]).toContain('web_search="live"');
      const thread = calls.find(c => c.method === 'thread/start').params;
      expect(thread.config).toMatchObject({ web_search: 'live', 'features.shell_tool': false, 'features.unified_exec': false, 'features.apply_patch_freeform': false });
      expect(thread.sandbox).toBe('read-only'); expect(thread.approvalPolicy).toBe('never');
      expect(calls.find(c => c.method === 'turn/start').params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
    } finally { rpc.close(); }
  });
  it('downgrades matches that cite pages absent from search events', async () => {
    actions = [{ type: 'search', query: 'Diet Coke' }];
    const rpc = new CodexRPC(true);
    try { expect((await rpc.recognize(input)).items[0]).toMatchObject({ status: 'unresolved', sources: [] }); } finally { rpc.close(); }
  });
  it('leaves extraction offline and rejects client tool requests', async () => {
    const rpc = new CodexRPC();
    try {
      await rpc.ready;
      send({ id: 99, method: 'item/tool/call', params: { name: 'shell' } });
      expect(calls.find(c => c.id === 99)?.error.code).toBe(-32601);
      await rpc.recognize(input);
      expect(vi.mocked(spawn).mock.calls[0][1]).toContain('web_search="disabled"');
      expect(calls.find(c => c.method === 'thread/start').params.config.web_search).toBe('disabled');
    } finally { rpc.close(); }
  });
});
