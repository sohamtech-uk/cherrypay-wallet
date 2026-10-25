import { useEffect, useRef, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { apiClient, connectPaymentAdapter, object, text, type TransferSigner } from './api';
import type { PaymentAdapter } from './model';
import { xlm } from './model';

/** Session tokens stay in memory. Refresh requires a new passkey login. */
export function PaymentConnection({ onConnect, signer }: { onConnect(adapter: PaymentAdapter | null): void; signer?: TransferSigner }) {
  const token = useRef<string | undefined>(undefined);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [accountId, setAccountId] = useState('');
  const [walletId, setWalletId] = useState('');
  const [canSign, setCanSign] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [balance, setBalance] = useState('');
  const lock = useRef(false);
  useEffect(() => () => { clearTimeout(expiry.current); token.current = undefined; }, []);
  async function connect(event: React.FormEvent) {
    event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError('');
    const api = apiClient(() => token.current);
    try {
      const challenge = object(await api('passkeys/authentication/options', { accountID: accountId.trim() }));
      // The browser library validates and serializes WebAuthn binary fields.
      const response = await startAuthentication({ optionsJSON: challenge.options as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
      const session = object(await api('passkeys/authentication/verify', { accountID: accountId.trim(), requestID: text(challenge.requestID), response }));
      if (session.verified !== true || session.accountID !== accountId.trim() || !Number.isSafeInteger(session.expiresInSeconds) || Number(session.expiresInSeconds) <= 0 || Number(session.expiresInSeconds) > 1800) throw Error('Invalid authenticated session.');
      token.current = text(session.token);
      const adapter = await connectPaymentAdapter(api, walletId.trim(), signer);
      clearTimeout(expiry.current);
      expiry.current = setTimeout(() => { token.current = undefined; setConnected(false); setBalance(''); onConnect(null); setError('Your session expired. Reconnect with your passkey.'); }, Number(session.expiresInSeconds) * 1000);
      onConnect(adapter); setCanSign(adapter.canSign !== false); setConnected(true);
      try { const snapshot = await adapter.getBalance!(); setBalance(snapshot ? `${xlm(snapshot.amountStroops)} XLM · ledger ${snapshot.ledger}` : 'Balance awaiting indexing'); } catch { setBalance('Balance temporarily unavailable'); }
    } catch (e) {
      if (token.current) { try { await api('session/logout', {}); } catch { /* Local authority is removed even if revocation cannot reach the API. */ } }
      token.current = undefined; onConnect(null); setConnected(false);
      setError(e instanceof Error ? e.message : 'Unable to connect your wallet.');
    } finally { lock.current = false; setBusy(false); }
  }
  async function disconnect() {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await apiClient(() => token.current)('session/logout', {}); }
    catch { setError('Disconnected locally. Server logout could not be confirmed; the session will expire.'); }
    finally { token.current = undefined; clearTimeout(expiry.current); onConnect(null); setConnected(false); setBalance(''); lock.current = false; setBusy(false); }
  }
  return <section className="card payment-screen" aria-label="Payment service connection"><h2>Connect an existing passkey wallet</h2><p>Use the account ID and deployed wallet ID supplied during wallet setup. A watch-only address cannot authorize payments.</p>
    {connected ? <><p role="status">Wallet connected. {balance}</p><p>{canSign ? 'Transaction approval connected.' : 'Transaction signing is not connected yet. You can inspect available wallet records.'}</p><button disabled={busy} onClick={() => void disconnect()}>Disconnect wallet</button></> : <form onSubmit={e => void connect(e)}><fieldset disabled={busy}><label htmlFor="account-id">Account ID</label><input id="account-id" value={accountId} onChange={e => setAccountId(e.target.value)} required autoComplete="off"/><label htmlFor="wallet-id">Deployed wallet ID</label><input id="wallet-id" value={walletId} onChange={e => setWalletId(e.target.value)} required autoComplete="off"/><button type="submit">{busy ? 'Connecting…' : 'Connect with passkey'}</button></fieldset></form>}
    {error && <p role="alert" className="error">{error}</p>}</section>;
}
