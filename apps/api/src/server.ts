import { buildApp } from './app.js';
import { initializeStore, db } from './store.js';

// Do not enable payments until on-chain smart-account authorization is verified.
const app = await buildApp();
async function shutdown() {
  try { await app.close(); } finally { await db.end(); }
}
// PostgreSQL may still be starting (or restarting after first-time init). Under `tsx watch`
// a failed startup never exits the process, so retry transient connection errors here.
const TRANSIENT_DB_ERRORS = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', '57P03']);
async function initializeStoreWithRetry(attempts = 30, delayMs = 2000) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await initializeStore();
    } catch (error) {
      const code = (error as { code?: string }).code;
      const transient = (code !== undefined && TRANSIENT_DB_ERRORS.has(code)) || /Connection terminated|timeout exceeded when trying to connect/i.test(String((error as Error).message));
      if (!transient || attempt >= attempts) throw error;
      app.log.warn({ code, attempt }, 'PostgreSQL not ready; retrying');
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}
try {
  await initializeStoreWithRetry();
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3001) });
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => { void shutdown().catch(() => { process.exitCode = 1; }); });
}
