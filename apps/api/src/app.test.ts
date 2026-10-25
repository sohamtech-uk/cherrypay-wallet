import { afterEach, describe, expect, it, vi } from 'vitest';
const identity = vi.hoisted(() => ({ sessionAccount: vi.fn(), revokeSession: vi.fn() }));
vi.mock('./store.js', () => ({ ...identity, hashToken: (value: string) => value, getCredentials: vi.fn(async () => []) }));
import { buildApp } from './app.js';
import { getConfig } from './config.js';
import { PaymentService } from './payments/service.js';
import { MemoryRepository } from './payments/test-support/memory-repository.js';
import { intent, mockChain, mockPolicy, wallet } from './payments/test-fixtures.js';
const config = getConfig({ WALLET_ORIGIN: 'https://wallet.example' });
const path = '/api/v1/wallets/wallet-1/attempts';
const headers = { origin: config.origin, authorization: 'Bearer verified-session', 'idempotency-key': 'idempotency-key-0001' };
afterEach(() => vi.resetAllMocks());
function payments() {
  const store = new MemoryRepository(); store.register(wallet);
  const service = new PaymentService(store, mockChain(), mockPolicy(), 1);
  vi.spyOn(service, 'tick').mockResolvedValue();
  return service;
}
describe('application payment composition', () => {
  it('keeps payment endpoints disabled by default', async () => {
    const app = await buildApp({ config, logger: false });
    try { expect((await app.inject({ url: path })).statusCode).toBe(503); expect(identity.sessionAccount).not.toHaveBeenCalled(); }
    finally { await app.close(); }
  });
  it('uses the verified session subject and enforces owner and origin boundaries', async () => {
    const app = await buildApp({ config, payments: payments(), logger: false });
    try {
      identity.sessionAccount.mockResolvedValue(null);
      expect((await app.inject({ url: path, headers })).statusCode).toBe(401);
      identity.sessionAccount.mockResolvedValue('bob');
      expect((await app.inject({ url: path, headers })).statusCode).toBe(404);
      identity.sessionAccount.mockResolvedValue('alice');
      expect((await app.inject({ method: 'POST', url: path, headers: { ...headers, origin: 'https://evil.example' }, payload: intent })).statusCode).toBe(403);
      const result = await app.inject({ method: 'POST', url: path, headers, payload: intent });
      expect(result.statusCode).toBe(202);
      expect(result.json().status).toBe('awaiting_approval');
      expect(identity.sessionAccount).toHaveBeenLastCalledWith('verified-session');
      identity.sessionAccount.mockResolvedValue(null);
      expect((await app.inject({ url: path, headers })).statusCode).toBe(401);
    } finally { await app.close(); }
  });
  it('fails closed on session database failure without leaking the error', async () => {
    identity.sessionAccount.mockRejectedValue(Error('private database detail'));
    const app = await buildApp({ config, payments: payments(), logger: false });
    try { const result = await app.inject({ url: path, headers }); expect(result.statusCode).toBe(503); expect(result.body).not.toContain('private'); }
    finally { await app.close(); }
  });
});

