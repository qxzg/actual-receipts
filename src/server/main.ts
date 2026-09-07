import { createApp } from './app.js';
import { loadConfig } from './config.js';
const config = loadConfig();
const { app } = await createApp(config);
await app.listen({ port: config.port, host: config.host });
console.log(`Receipt Ledger listening on ${config.host}:${config.port}`);
const stop = async () => { await app.close(); process.exit(0); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
