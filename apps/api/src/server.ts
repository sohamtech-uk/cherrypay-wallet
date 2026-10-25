import { buildApp } from './app.js';
import { initializeStore, db } from './store.js';

// Do not enable payments until on-chain smart-account authorization is verified.
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
