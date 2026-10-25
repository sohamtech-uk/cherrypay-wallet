import { useEffect, useRef, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { apiClient, connectPaymentAdapter, discoverWallets, object, text, type OwnedWallet, type TransferSigner } from './api';
import type { PaymentAdapter } from './model';

const accountStorageKey = 'cherrypay:testnet:account-id';
const deploymentStatuses = ['NOT_STARTED', 'PENDING', 'AWAITING_PASSKEY', 'SUBMITTED', 'CONFIRMED', 'ACTIVE', 'FAILED'];
function savedAccountId() { try { return localStorage.getItem(accountStorageKey) ?? ''; } catch { return ''; } }
async function revoke(value: string) { await apiClient(() => value)('session/logout', {}); }

/** Only the public account ID is remembered. Session authority stays in memory. */
export function PaymentConnection({ onConnect, signer }: { onConnect(adapter: PaymentAdapter | null): void; signer?: TransferSigner }) {
  const token = useRef<string | undefined>(undefined);
  const deadline = useRef(0);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const lock = useRef(false);
  const [accountId, setAccountId] = useState(savedAccountId);
  const [walletId, setWalletId] = useState('');
  const [wallets, setWallets] = useState<OwnedWallet[]>([]);
  const [authenticated, setAuthenticated] = useState(false);
  const [credentialCount, setCredentialCount] = useState(0);
  const [canSign, setCanSign] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deploymentStatus, setDeploymentStatus] = useState('');
  useEffect(() => () => {
    generation.current++; clearTimeout(expiry.current);
    const abandoned = token.current; token.current = undefined;
    if (abandoned) void revoke(abandoned).catch(() => { /* Server expiry bounds an interrupted logout. */ });
  }, []);
  const active = (id: number) => generation.current === id && !!token.current && Date.now() < deadline.current;
  function clearSession(message = '') {
    generation.current++; token.current = undefined; clearTimeout(expiry.current);
    setAuthenticated(false); setConnected(false); setCredentialCount(0); setWallets([]); setWalletId(''); setDeploymentStatus('');
    lock.current = false; setBusy(false); onConnect(null); setError(message);
  }
  async function openWallet(selected: OwnedWallet, id: number) {
    const adapter = await connectPaymentAdapter(apiClient(() => token.current), selected.id, signer);
    if (!active(id)) return;
    if (adapter.address !== selected.address) throw Error('Wallet identity changed. Reconnect to refresh your wallets.');
    onConnect(adapter); setCanSign(adapter.canSign !== false); setConnected(true);
  }
  async function loadWallets(id: number) {
    const owned = await discoverWallets(apiClient(() => token.current));
    if (!active(id)) return;
    setWallets(owned); setWalletId(owned[0]?.id ?? ''); setDeploymentStatus('');
    if (owned.length === 0) {
      // Reservation status is not authentication or on-chain authority. An outage here
      // must not invalidate a successful passkey enrollment/login or claim a deployment.
      try {
        const job = object(await apiClient(() => token.current)('smart-account/deployment', {}));
        if (!active(id)) return;
        const status = text(job.status);
        if (!deploymentStatuses.includes(status) || job.deploymentEnabled !== false) throw Error('Invalid deployment status.');
        setDeploymentStatus(status);
      } catch {
        if (!active(id)) return;
        setDeploymentStatus('UNAVAILABLE');
        setError('Provisioning status is unavailable. Your passkey profile remains connected. Disconnect and reconnect to retry.');
      }
    } else setDeploymentStatus('ACTIVE');
    if (owned.length === 1) await openWallet(owned[0], id);
  }
  async function adoptSession(value: unknown, owner: string, id: number) {
    const session = object(value), verifiedToken = text(session.token);
    if (generation.current !== id) { await revoke(verifiedToken).catch(() => {}); return false; }
    if (session.verified !== true || session.accountID !== owner || !Number.isSafeInteger(session.expiresInSeconds) || Number(session.expiresInSeconds) <= 0 || Number(session.expiresInSeconds) > 1800 || !Number.isSafeInteger(session.credentialCount) || Number(session.credentialCount) < 1) {
      await revoke(verifiedToken).catch(() => {});
      throw Error('Invalid authenticated session. Reconnect with your account ID.');
    }
    const previous = token.current;
    // Invalidate any open review when a newly verified session replaces the old one.
    if (previous) { onConnect(null); setConnected(false); }
    clearTimeout(expiry.current); setDeploymentStatus('');
    token.current = verifiedToken; deadline.current = Date.now() + Number(session.expiresInSeconds) * 1000;
    expiry.current = setTimeout(() => clearSession('Your session expired. Reconnect with your passkey.'), Number(session.expiresInSeconds) * 1000);
    setAuthenticated(true); setCredentialCount(Number(session.credentialCount));
    if (previous && previous !== verifiedToken) {
      try { await revoke(previous); }
      catch { if (active(id)) setError('Your new session is active. Previous session logout could not be confirmed; it will expire.'); }
    }
    return active(id);
  }
  async function fail(id: number, e: unknown, registration = false) {
    if (generation.current !== id) return;
    const abandoned = token.current;
    const message = e instanceof Error ? e.message : 'Unable to connect your account.';
    clearSession(registration ? `${message} If a passkey was created, reconnect with this account ID before enrolling again.` : message);
    if (abandoned) await revoke(abandoned).catch(() => {});
  }
  async function connect(event: React.FormEvent) {
    event.preventDefault(); if (lock.current) return;
    const id = ++generation.current, owner = accountId.trim(); lock.current = true; setBusy(true); setError(''); setNotice('');
    const api = apiClient(() => undefined);
    try {
      const challenge = object(await api('passkeys/authentication/options', { accountID: owner }));
      if (generation.current !== id) return;
      const response = await startAuthentication({ optionsJSON: challenge.options as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
      if (generation.current !== id) return;
      const session = await api('passkeys/authentication/verify', { accountID: owner, requestID: text(challenge.requestID), response });
      if (await adoptSession(session, owner, id)) { setAccountId(owner); await loadWallets(id); }
    } catch (e) { await fail(id, e); }
    finally { if (generation.current === id) { lock.current = false; setBusy(false); } }
  }
  async function register(additional: boolean) {
    if (lock.current) return;
    if (additional && !active(generation.current)) { clearSession('Reconnect before adding a passkey.'); return; }
    const id = ++generation.current; lock.current = true; setBusy(true); setError(''); setNotice('');
    const api = apiClient(() => token.current);
    let verifying = false;
    try {
      const challenge = object(await api('passkeys/registration/options', additional ? { accountID: accountId } : {}));
      if (generation.current !== id) return;
      const owner = text(challenge.accountID);
      if (additional && owner !== accountId) throw Error('Enrollment account changed. Reconnect before trying again.');
      if (!additional) {
        setAccountId(owner);
        // Save before the ceremony: verification might commit while its response is lost.
        try { localStorage.setItem(accountStorageKey, owner); setNotice('Your account ID is saved on this browser. Keep a separate copy for sign-in.'); }
        catch { setNotice('This browser cannot save your account ID. Copy it and keep it for sign-in.'); }
      }
      const response = await startRegistration({ optionsJSON: challenge.options as Parameters<typeof startRegistration>[0]['optionsJSON'] });
      if (generation.current !== id) return;
      verifying = true;
      const session = await api('passkeys/registration/verify', { accountID: owner, requestID: text(challenge.requestID), response });
      if (await adoptSession(session, owner, id)) {
        if (additional) setNotice('Additional passkey enrolled for sign-in. This does not change your wallet’s on-chain signers or verify recovery.');
        await loadWallets(id);
      }
    } catch (e) {
      // Cancelling a backup ceremony before verification leaves the existing session usable.
      if (additional && !verifying && active(id)) setError(e instanceof Error ? e.message : 'Passkey enrollment cancelled. Try again when ready.');
      else await fail(id, e, true);
    } finally { if (generation.current === id) { lock.current = false; setBusy(false); } }
  }
  async function choose(event: React.FormEvent) {
    event.preventDefault(); if (lock.current) return;
    const id = generation.current, selected = wallets.find(w => w.id === walletId);
    if (!active(id)) { clearSession('Your session expired. Reconnect with your passkey.'); return; }
    if (!selected) { setError('Choose an available wallet.'); return; }
    lock.current = true; setBusy(true); setError('');
    try { await openWallet(selected, id); }
    catch (e) { if (active(id)) { onConnect(null); setConnected(false); setError(e instanceof Error ? e.message : 'Unable to open this wallet.'); } }
    finally { if (generation.current === id) { lock.current = false; setBusy(false); } }
  }
  async function disconnect() {
    const abandoned = token.current;
    clearSession(); setNotice(''); const id = generation.current;
    if (abandoned) {
      try { await revoke(abandoned); }
      catch { if (generation.current === id) setError('Disconnected locally. Server logout could not be confirmed; the session will expire.'); }
    }
  }
  async function copyAccount() {
    try { await navigator.clipboard.writeText(accountId); setNotice('Account ID copied. Keep it for sign-in; it cannot replace a passkey.'); }
    catch { setError('Copy failed. Select the account ID and copy it manually.'); }
  }
  return <section className="card payment-screen" aria-label="Payment service connection" aria-busy={busy}>
    <h2>{authenticated ? 'Your passkey profile' : 'Connect or create a passkey profile'}</h2>
    <p>Use your account ID and passkey to find your linked Testnet wallets. Creating a profile does not deploy or fund a wallet.</p>
    {authenticated ? <>
      <label htmlFor="profile-account-id">Account ID</label><input id="profile-account-id" value={accountId} readOnly/>
      <p>{credentialCount} {credentialCount === 1 ? 'passkey' : 'passkeys'} enrolled for sign-in.</p>
      {connected ? <><p role="status">Wallet connected.</p><p>{canSign ? 'Transaction approval connected.' : 'Transaction signing is not connected yet. You can inspect available wallet records.'}</p></> : busy ? <p role="status">Loading your wallets…</p> : wallets.length === 0 ? <p role="status">No deployed C-address wallet is linked to this account yet. {deploymentStatus === 'AWAITING_PASSKEY' ? 'Add an independent backup passkey to prepare automatic wallet deployment.' : `Provisioning status: ${deploymentStatus || 'NOT_STARTED'}. Deployment confirmation is pending.`}</p> : <form onSubmit={e => void choose(e)}><fieldset disabled={busy}><label htmlFor="owned-wallet">Choose your wallet</label><select id="owned-wallet" value={walletId} onChange={e => setWalletId(e.target.value)}>{wallets.map(w => <option key={w.id} value={w.id}>{w.address}</option>)}</select><button type="submit">Open wallet</button></fieldset></form>}
      <p>Add an independent passkey on another device or security key. Two enrolled credentials are required before deployment is queued. On-chain signer binding and recovery must still be verified.</p>
      <button disabled={busy} onClick={() => void register(true)}>Add another passkey</button>
      <button className="secondary-button" onClick={() => void disconnect()}>Disconnect wallet</button>
    </> : <>
      <form onSubmit={e => void connect(e)}><fieldset disabled={busy}><label htmlFor="account-id">Account ID</label><input id="account-id" value={accountId} onChange={e => setAccountId(e.target.value)} required autoComplete="off"/><button type="submit">{busy ? 'Please wait…' : 'Connect with passkey'}</button></fieldset></form>
      <button className="secondary-button" disabled={busy} onClick={() => void register(false)}>Create passkey profile</button>
      <p>New here? Create a profile, save its account ID, then add another passkey. Your device manages the passkeys.</p>
    </>}
    {accountId && <button className="secondary-button" onClick={() => void copyAccount()}>Copy account ID</button>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
