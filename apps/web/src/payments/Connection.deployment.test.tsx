// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { PaymentConnection } from './Connection';

vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn(), startRegistration: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.mocked(startAuthentication).mockResolvedValue({ id: 'credential' } as Awaited<ReturnType<typeof startAuthentication>>);
  vi.mocked(startRegistration).mockResolvedValue({ id: 'new-credential' } as Awaited<ReturnType<typeof startRegistration>>);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const pending = () => response({ status: 'PENDING', address: null, transactionHash: null, deploymentEnabled: false }, 202);
function fixture(deployment: () => Promise<Response>, seconds = 1800) {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/options')) return response({ accountID: 'account-1', requestID: 'challenge', options: { challenge: 'challenge' } });
    if (url.endsWith('/verify')) return response({ verified: true, accountID: 'account-1', token: 'secret-session', expiresInSeconds: seconds, credentialCount: 1 });
    if (url.endsWith('/wallets')) return response({ network: 'TESTNET', items: [] });
    if (url.endsWith('/smart-account/deployment')) return deployment();
    if (url.endsWith('/logout')) return new Response(null, { status: 204 });
    throw Error('Unexpected test endpoint');
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Account ID'), 'account-1');
  await user.click(screen.getByRole('button', { name: 'Connect with passkey' }));
}

it.each(['unavailable', 'missing-status', 'unknown-status', 'unexpected-enablement'])('keeps a verified profile connected when deployment status is %s', async failure => {
  const fetcher = fixture(async () => {
    if (failure === 'unavailable') return response({ error: 'PRIVATE_DATABASE_DETAIL' }, 503);
    if (failure === 'missing-status') return response({ deploymentEnabled: false });
    if (failure === 'unknown-status') return response({ status: 'ARBITRARY_UNTRUSTED_VALUE', deploymentEnabled: false });
    return response({ status: 'ACTIVE', deploymentEnabled: true });
  });
  const onConnect = vi.fn(), user = userEvent.setup();
  render(<PaymentConnection onConnect={onConnect}/>);
  await signIn(user);
  expect((await screen.findByRole('alert')).textContent).toContain('Your passkey profile remains connected');
  expect(screen.getByText(/1 passkey enrolled/)).toBeTruthy();
  expect(screen.getByText(/Provisioning status: UNAVAILABLE/)).toBeTruthy();
  expect(screen.getByText(/On-chain deployment is not enabled yet/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add another passkey' })).toHaveProperty('disabled', false);
  expect(onConnect).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/logout'))).toBe(false);
  expect(screen.queryByText(/PRIVATE_DATABASE_DETAIL|ARBITRARY_UNTRUSTED_VALUE/)).toBeNull();
});

it('keeps a newly enrolled profile usable when the reservation request times out', async () => {
  const fetcher = fixture(async () => { throw Error('Network timeout'); });
  const user = userEvent.setup(); render(<PaymentConnection onConnect={vi.fn()}/>);
  await user.click(screen.getByRole('button', { name: 'Create passkey profile' }));
  await screen.findByRole('alert');
  expect(screen.getByText(/1 passkey enrolled/)).toBeTruthy();
  expect(localStorage.getItem('cherrypay:testnet:account-id')).toBe('account-1');
  expect(startRegistration).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/registration/verify'))).toHaveLength(1);
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/logout'))).toBe(false);
});

it('ignores a pending deployment response after disconnect', async () => {
  let complete: ((value: Response) => void) | undefined;
  fixture(() => new Promise(resolve => { complete = resolve; }));
  const onConnect = vi.fn(), user = userEvent.setup(); render(<PaymentConnection onConnect={onConnect}/>);
  await signIn(user);
  expect(complete).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Disconnect wallet' }));
  await act(async () => { complete!(pending()); });
  expect(screen.getByRole('button', { name: 'Connect with passkey' })).toBeTruthy();
  expect(screen.queryByText(/Provisioning status/)).toBeNull();
  expect(screen.queryByText(/1 passkey enrolled/)).toBeNull();
  expect(onConnect.mock.calls.every(([value]) => value === null)).toBe(true);
});

it('ignores deployment responses after the authenticated session expires', async () => {
  vi.useFakeTimers();
  let complete: ((value: Response) => void) | undefined;
  fixture(() => new Promise(resolve => { complete = resolve; }), 1);
  const onConnect = vi.fn(); render(<PaymentConnection onConnect={onConnect}/>);
  fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: 'account-1' } });
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Connect with passkey' }).closest('form')!); });
  expect(complete).toBeDefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect(screen.getByRole('alert').textContent).toContain('session expired');
  await act(async () => { complete!(pending()); });
  expect(screen.queryByText(/Provisioning status/)).toBeNull();
  expect(screen.queryByText(/1 passkey enrolled/)).toBeNull();
  expect(onConnect.mock.calls.every(([value]) => value === null)).toBe(true);
});
