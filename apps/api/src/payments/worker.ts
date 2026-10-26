import type { PaymentService } from './service.js';
/** No overlapping ticks; shutdown drains the active tick before closing persistence. */
export function startPaymentWorker(service: Pick<PaymentService,'tick'>, onError: (code: string) => void, intervalMs = 5000) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void>;
  async function tick() {
    try { await service.tick(); } catch { onError('PAYMENT_MONITOR_RETRY_REQUIRED'); }
    if (!stopped) {
      timer = setTimeout(() => { active = tick(); }, intervalMs);
      timer.unref();
    }
  }
  active = tick();
  return async () => { stopped = true; clearTimeout(timer); await active; };
}
