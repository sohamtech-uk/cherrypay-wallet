import { useEffect, useRef, useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { apiClient, connectPaymentAdapter, discoverWallets, object, text, type OwnedWallet, type TransferSigner } from './api';
import type { PaymentAdapter } from './model';
import { xlm } from './model';

/** Session tokens stay in memory. Refresh requires a new passkey login. */
export function PaymentConnection({ onConnect, signer }: { onConnect(adapter: PaymentAdapter | null): void; signer?: TransferSigner }) {
  const token = useRef<string | undefined>(undefined);
  const deadline = useRef(0);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const lock = useRef(false);
  const [accountId, setAccountId] = useState('');
  const [walletId, setWalletId] = useState('');
  const [wallets, setWallets] = useState<OwnedWallet[]>([]);
  const [authenticated, setAuthenticated] = useState(false);
  const [canSign, setCanSign] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [balance, setBalance] = useState('');
  useEffect(() => () => { generation.current++; clearTimeout(expiry.current); token.current = undefined; }, []);
  const active = (id: number) => generation.current === id && !!token.current && Date.now() < deadline.current;
  function clearSession(message = '') {
    generation.current++; token.current = undefined; clearTimeout(expiry.current);
    setAuthenticated(false); setConnected(false); setWallets([]); setWalletId(''); setBalance('');
    lock.current = false; setBusy(false); onConnect(null); setError(message);
  }
  async function openWallet(selected: OwnedWallet, id: number) {
    const adapter = await connectPaymentAdapter(apiClient(() => token.current), selected.id, signer);
    if (!active(id)) return;
    if (adapter.address !== selected.address) throw Error('Wallet identity changed. Reconnect to refresh your wallets.');
    onConnect(adapter); setCanSign(adapter.canSign !== false); setConnected(true);
    try {
      const snapshot = await adapter.getBalance!();
      if (active(id)) setBalance(snapshot ? `${xlm(snapshot.amountStroops)} XLM · ledger ${snapshot.ledger}` : 'Balance awaiting indexing');
    } catch { if (active(id)) setBalance('Balance temporarily unavailable'); }
  }
  async function connect(event: React.FormEvent) {
    event.preventDefault(); if (lock.current) return;
    const id = ++generation.current; lock.current = true; setBusy(true); setError('');
    const api = apiClient(() => token.current);
    try {
      const challenge = object(await api('passkeys/authentication/options', { accountID: accountId.trim() }));
      if (generation.current !== id) return;
      const response = await startAuthentication({ optionsJSON: challenge.options as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
      if (generation.current !== id) return;
      const session = object(await api('passkeys/authentication/verify', { accountID: accountId.trim(), requestID: text(challenge.requestID), response }));
      if (session.verified !== true || session.accountID !== accountId.trim() || !Number.isSafeInteger(session.expiresInSeconds) || Number(session.expiresInSeconds) <= 0 || Number(session.expiresInSeconds) > 1800) throw Error('Invalid authenticated session.');
      const verifiedToken = text(session.token);
      if (generation.current !== id) {
        try { await apiClient(() => verifiedToken)('session/logout', {}); } catch { /* Expiry limits the abandoned session. */ }
        return;
      }
      token.current = verifiedToken; deadline.current = Date.now() + Number(session.expiresInSeconds) * 1000;
      expiry.current = setTimeout(() => clearSession('Your session expired. Reconnect with your passkey.'), Number(session.expiresInSeconds) * 1000);
      setAuthenticated(true);
      const owned = await discoverWallets(api);
      if (!active(id)) return;
      setWallets(owned); setWalletId(owned[0]?.id ?? '');
      if (owned.length === 1) await openWallet(owned[0], id);
    } catch (e) {
      if (generation.current !== id) return;
      const message = e instanceof Error ? e.message : 'Unable to connect your wallet.';
      const abandoned = token.current;
      clearSession(message);
      if (abandoned) { try { await apiClient(() => abandoned)('session/logout', {}); } catch { /* Local authority was already removed. */ } }
    } finally { if (generation.current === id) { lock.current = false; setBusy(false); } }
  }
  async function choose(event: React.FormEvent) {
    event.preventDefault(); if (lock.current) return;
    const id = generation.current, selected = wallets.find(w => w.id === walletId);
    if (!active(id)) { clearSession('Your session expired. Reconnect with your passkey.'); return; }
    if (!selected) { setError('Choose an available wallet.'); return; }
    lock.current = true; setBusy(true); setError('');
    try { await openWallet(selected, id); }
    catch (e) { if (active(id)) { onConnect(null); setError(e instanceof Error ? e.message : 'Unable to open this wallet.'); } }
    finally { if (generation.current === id) { lock.current = false; setBusy(false); } }
  }
  async function disconnect() {
    const abandoned = token.current;
    clearSession(); const id = generation.current;
    if (abandoned) {
      try { await apiClient(() => abandoned)('session/logout', {}); }
      catch { if (generation.current === id) setError('Disconnected locally. Server logout could not be confirmed; the session will expire.'); }
    }
  }
  return <section className="card payment-screen" aria-label="Payment service connection">
    <h2>Connect an existing passkey wallet</h2>
    <p>Sign in with your account ID and passkey to find your deployed Testnet wallets.</p>
    {connected ? <><p role="status">Wallet connected. {balance}</p><p>{canSign ? 'Transaction approval connected.' : 'Transaction signing is not connected yet. You can inspect available wallet records.'}</p></> : authenticated ? <>
      {busy ? <p role="status">Loading your wallets…</p> : wallets.length === 0 ? <p role="status">No deployed wallet is linked to this account yet. Complete wallet setup, then reconnect.</p> : <form onSubmit={e => void choose(e)}><fieldset disabled={busy}><label htmlFor="owned-wallet">Choose your wallet</label><select id="owned-wallet" value={walletId} onChange={e => setWalletId(e.target.value)}>{wallets.map(w => <option key={w.id} value={w.id}>{w.address}</option>)}</select><button type="submit">Open wallet</button></fieldset></form>}
    </> : <form onSubmit={e => void connect(e)}><fieldset disabled={busy}><label htmlFor="account-id">Account ID</label><input id="account-id" value={accountId} onChange={e => setAccountId(e.target.value)} required autoComplete="off"/><button type="submit">{busy ? 'Connecting…' : 'Connect with passkey'}</button></fieldset></form>}
    {authenticated && <button onClick={() => void disconnect()}>Disconnect wallet</button>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
