import { buildApp } from './app.js';
import { initializeStore, db } from './store.js';
import { ruleReaderRuntimeFromEnv } from './smart-account/runtime.js';

// Payments are enabled only when PAYMENT_RELAYER_SECRET is set and every registered
// Testnet wallet passes on-chain code, signer-rule, ownership and recovery checks.
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
async function shutdown() {
  try { await app?.close(); } finally { await db.end(); }
}
try {
  await initializeStore();
  const runtime = await ruleReaderRuntimeFromEnv(process.env);
  app = await buildApp(runtime ? { payments: runtime.payments, passkeyCodec: runtime.passkeyCodec, receiveRoute: runtime.receiveRoute } : {});
  app.log.info({ paymentsEnabled: !!runtime }, 'Payment runtime');
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3001) });
} catch (error) {
  if (app) app.log.error(error); else console.error(error instanceof Error ? error.message : error);
  await shutdown();
  process.exitCode = 1;
}

