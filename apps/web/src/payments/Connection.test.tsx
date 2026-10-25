// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentConnection } from './Connection';
import { StrKey } from '@stellar/stellar-sdk';
import { startAuthentication } from '@simplewebauthn/browser';
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn(async () => ({ id: 'credential' })) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('connects with a verified passkey session, keeps tokens out of storage, and revokes on logout', async () => {
  const address = StrKey.encodeContract(Buffer.alloc(32, 1));
  const fetcher = vi.fn(async (url: string) => {
    let data: unknown;
    if (url.endsWith('/options')) data = { requestID: 'challenge', options: { challenge: 'challenge' } };
    else if (url.endsWith('/verify')) data = { verified: true, accountID: 'account-1', token: 'secret-session', expiresInSeconds: 1800 };
    else if (url.endsWith('/balance')) data = { network: 'TESTNET', address, snapshot: null };
    else if (url.endsWith('/logout')) return new Response(null, { status: 204 });
    else data = { id: 'wallet-1', network: 'TESTNET', address, supportedDestinations: ['classic'] };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  const local = vi.spyOn(Storage.prototype, 'setItem'); const onConnect = vi.fn();
  const user = userEvent.setup(); render(<PaymentConnection onConnect={onConnect}/>);
  await user.type(screen.getByLabelText('Account ID'), 'account-1');
  await user.type(screen.getByLabelText('Deployed wallet ID'), 'wallet-1');
  await user.click(screen.getByRole('button', { name: 'Connect with passkey' }));
  await screen.findByRole('button', { name: 'Disconnect wallet' });
  expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'challenge' } });
  expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({ address, canSign: false }));
  expect(local).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Disconnect wallet' }));
  await screen.findByRole('button', { name: 'Connect with passkey' });
  expect(onConnect).toHaveBeenLastCalledWith(null);
  expect(fetcher).toHaveBeenCalledWith('/api/v1/session/logout', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer secret-session' }) }));
  local.mockRestore();
});
it('does not connect when passkey verification fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/options') ? { requestID: 'challenge', options: {} } : { error: 'denied' }), { status: url.endsWith('/options') ? 200 : 400 })));
  const onConnect = vi.fn(); const user = userEvent.setup(); render(<PaymentConnection onConnect={onConnect}/>);
  await user.type(screen.getByLabelText('Account ID'), 'account-1'); await user.type(screen.getByLabelText('Deployed wallet ID'), 'wallet-1');
  await user.click(screen.getByRole('button', { name: 'Connect with passkey' })); await screen.findByRole('alert');
  expect(onConnect).toHaveBeenCalledWith(null); expect(screen.queryByRole('button', { name: 'Disconnect wallet' })).toBeNull();
});
