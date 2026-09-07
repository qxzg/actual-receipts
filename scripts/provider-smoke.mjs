import { CodexRPC } from '../dist/provider/rpc.js';
const rpc = new CodexRPC();
try { await rpc.ready; const r = await rpc.call('account/read', {refreshToken:false}); console.log(JSON.stringify({protocol:'initialized',authenticated:!!r.account})); }
finally { rpc.close(); }
