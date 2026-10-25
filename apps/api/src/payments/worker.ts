import type { PaymentService } from './service.js';
/** No overlapping ticks; database leases also fence separate worker processes. */
export function startPaymentWorker(service: PaymentService, onError: (code: string) => void, intervalMs = 5000) {
  let stopped = false; let timer: ReturnType<typeof setTimeout>;
  async function tick() {
    try { await service.tick(); } catch { onError('PAYMENT_MONITOR_RETRY_REQUIRED'); }
    if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref(); }
  }
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
