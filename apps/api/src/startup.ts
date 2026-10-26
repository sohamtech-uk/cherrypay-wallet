import { configuredIndexer } from './indexing/config.js';
import { buildApp } from './app.js';
import { getConfig } from './config.js';
import { initializeStore, db } from './store.js';
import { configuredPayments } from './smart-account/manifest.js';
import { configuredDeployments } from './smart-account/automatic-deployment.js';
import { initializeStoreWithRetry } from './database-startup.js';

type AppOptions = NonNullable<Parameters<typeof buildApp>[0]>;
const defaults = {
  initialize: initializeStore,
  payments: async (env: NodeJS.ProcessEnv): Promise<AppOptions> => ({ ...(await configuredPayments(env)), deployments: await configuredDeployments(env), indexer: configuredIndexer(env) }),
  build: buildApp,
  closeStore: () => db.end(),
};
/** No listener or monitor starts until migrations and configured runtime checks pass. */
export async function startServer(env: NodeJS.ProcessEnv = process.env, dependencies = defaults, signal?: AbortSignal) {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let closing: Promise<void> | undefined;
  const shutdown = () => closing ??= (async () => {
    try { await app?.close(); } finally { await dependencies.closeStore(); }
  })();
  try {
    const config = getConfig(env);
    await initializeStoreWithRetry(dependencies.initialize,{signal});
    signal?.throwIfAborted();
    const runtime = await dependencies.payments(env);
    signal?.throwIfAborted();
    app = await dependencies.build({ ...runtime, config });
    signal?.throwIfAborted();
    await app.listen({ host: env.HOST ?? '127.0.0.1', port: config.port });
    signal?.throwIfAborted();
    return { app, shutdown };
  } catch (error) {
    await shutdown().catch(() => {});
    throw error;
  }
}
