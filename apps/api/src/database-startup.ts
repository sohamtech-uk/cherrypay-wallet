import { setTimeout as delay } from 'node:timers/promises';

// Preserve PR #24's bounded retry for PostgreSQL's first-start/restart window.
const transientCodes = new Set(['ECONNREFUSED','ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ECONNRESET','57P03']);
export async function initializeStoreWithRetry(initialize: () => Promise<void>, options: {
  signal?: AbortSignal;
  wait?: () => Promise<unknown>;
  warn?: (details: {code:string;attempt:number}) => void;
} = {}) {
  const wait = options.wait ?? (() => delay(2000, undefined, {signal:options.signal}));
  const warn = options.warn ?? (details => console.warn('POSTGRES_STARTUP_RETRY', details));
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    try { return await initialize(); }
    catch (error) {
      const code = (error as {code?:string})?.code;
      const known = typeof code === 'string' && transientCodes.has(code);
      const transient = known || /Connection terminated|timeout exceeded when trying to connect/i.test(String((error as Error)?.message));
      if (!transient || attempt >= 30) throw error;
      warn({code:known?code:'DB_CONNECTION_UNAVAILABLE',attempt});
      await wait();
    }
  }
}
