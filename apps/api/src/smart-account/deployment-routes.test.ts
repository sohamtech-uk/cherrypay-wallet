import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sessionAccount: vi.fn(), getCredentials: vi.fn(), emailForAccount: vi.fn(), query: vi.fn() }));
vi.mock('../store.js', () => ({ sessionAccount: mocks.sessionAccount, getCredentials: mocks.getCredentials,
  emailForAccount: mocks.emailForAccount, db: { query: mocks.query } }));
import { registerDeploymentRoutes } from './deployment-routes.js';
const url = '/api/v1/smart-account/deployment';
const headers = { authorization: 'Bearer valid-token' };
const pending = { status: 'PENDING', contract_address: null, transaction_hash: null, attempt_count: 0, failure_code: null, updated_at: new Date() };
describe('automatic C-wallet reservation safety', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.sessionAccount.mockResolvedValue('alice@example.com');
    mocks.emailForAccount.mockResolvedValue({ email: 'alice@example.com', email_verified_at: new Date() });
    mocks.getCredentials.mockResolvedValue([{ id: 'primary' }, { id: 'backup' }]);
    mocks.query.mockResolvedValue({ rows: [pending] }); });
  async function request(method: 'GET' | 'POST', authenticated = true) {
    const app = Fastify(); await registerDeploymentRoutes(app);
    try { return await app.inject({ method, url, headers: authenticated ? headers : {} }); }
    finally { await app.close(); }
  }
  it('requires a session for both endpoints', async () => {
    mocks.sessionAccount.mockResolvedValue(null);
    expect((await request('GET', false)).statusCode).toBe(401);
    expect((await request('POST', false)).statusCode).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('blocks unverified email before creating a job', async () => {
    mocks.emailForAccount.mockResolvedValue({ email: 'alice@example.com', email_verified_at: null });
    expect((await request('POST')).json()).toEqual({ error: 'EMAIL_VERIFICATION_REQUIRED' });
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('reserves a pending job only with two passkeys', async () => {
    const response = await request('POST');
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'PENDING', deploymentEnabled: false, spendingEnabled: false });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT(account_id)'), ['alice@example.com', 'PENDING']);
  });
  it('requests a backup when one passkey exists', async () => {
    mocks.getCredentials.mockResolvedValue([{ id: 'primary' }]);
    mocks.query.mockResolvedValue({ rows: [{ ...pending, status: 'AWAITING_PASSKEY' }] });
    expect((await request('POST')).json()).toMatchObject({ status: 'AWAITING_PASSKEY', nextAction: 'ENROLL_INDEPENDENT_BACKUP_PASSKEY' });
  });
  it('never advertises chain success for a stored reservation', async () => {
    expect((await request('GET')).json()).toMatchObject({ status: 'PENDING', address: null, deploymentEnabled: false, recoveryReady: false });
  });
});
