import { CodexRPC } from './rpc.js';

// Keep catalog discovery separate from the long-lived device-login session.
// Each request loads the current account and the installed CLI's model catalog.
export async function listCodexModels() {
  const rpc = new CodexRPC();
  try {
    await rpc.ready;
    const { account } = await rpc.call('account/read', { refreshToken: false });
    if (!account) return null;
    const models: any[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await rpc.call('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
      models.push(...page.data);
      cursor = page.nextCursor || undefined;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error('模型列表分页无效，请重试');
        cursors.add(cursor);
      }
    } while (cursor && models.length < 500);
    return models.slice(0, 500).map(m => ({
      id: m.model, name: m.displayName, description: m.description, hidden: m.hidden,
      isDefault: !!m.isDefault, inputModalities: m.inputModalities || null,
    }));
  } finally { rpc.close(); }
}
