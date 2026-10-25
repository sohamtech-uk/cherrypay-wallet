import { buildApp } from './app.js';
import { initializeStore, db } from './store.js';

// No default policy reader: database credentials do not prove on-chain ownership.
const app = await buildApp();
async function shutdown() {
  try { await app.close(); } finally { await db.end(); }
}
try {
  await initializeStore();
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3001) });
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { void shutdown().catch(() => { process.exitCode = 1; }); });
}
