import { afterEach, expect, it, vi } from 'vitest';
import { startPaymentWorker } from './worker.js';
import type { PaymentService } from './service.js';
afterEach(() => vi.useRealTimers());
it('drains an in-flight tick and schedules nothing after shutdown', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const tick = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const stop = startPaymentWorker({ tick } as unknown as PaymentService, vi.fn(), 10);
  await vi.advanceTimersByTimeAsync(100);
  expect(tick).toHaveBeenCalledTimes(1);
  let stopped = false;
  const draining = stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  finish(); await draining;
  await vi.advanceTimersByTimeAsync(100);
  expect(tick).toHaveBeenCalledTimes(1);
});
it('reports a stable error and retries serially', async () => {
  vi.useFakeTimers();
  const tick = vi.fn().mockRejectedValueOnce(Error('secret')).mockResolvedValue(undefined);
  const errors = vi.fn();
  const stop = startPaymentWorker({ tick } as unknown as PaymentService, errors, 10);
  await vi.advanceTimersByTimeAsync(10);
  expect(errors).toHaveBeenCalledWith('PAYMENT_MONITOR_RETRY_REQUIRED');
  expect(tick).toHaveBeenCalledTimes(2);
  await stop(); await vi.advanceTimersByTimeAsync(100);
  expect(tick).toHaveBeenCalledTimes(2);
});
