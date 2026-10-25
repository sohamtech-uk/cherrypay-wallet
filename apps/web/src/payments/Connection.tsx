import { useEffect, useRef, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ApiError, apiClient, connectPaymentAdapter, discoverWallets, object, text, type OwnedWallet, type TransferSigner } from './api';
import { parseDeployment, type DeploymentView } from './deployment';
import type { PaymentAdapter } from './model';

const accountStorageKey = 'cherrypay:testnet:account-id';
function savedAccountId() { try { return localStorage.getItem(accountStorageKey) ?? ''; } catch { return ''; } }
async function revoke(value: string) { await apiClient(() => value)('session/logout', {}); }

/** Only the public account ID is remembered. Session authority stays in memory. */
export function PaymentConnection({ onConnect, signer }: { onConnect(adapter: PaymentAdapter | null): void; signer?: TransferSigner }) {
  const token = useRef<string | undefined>(undefined);
  const deadline = useRef(0);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const poll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const lock = useRef(false);
  const [accountId, setAccountId] = useState(savedAccountId);
  const [email, setEmail] = useState(savedAccountId);
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
  const [deployment, setDeployment] = useState<DeploymentView | null>(null);
  useEffect(() => () => {
    generation.current++; clearTimeout(expiry.current); clearTimeout(poll.current);
    const abandoned = token.current; token.current = undefined;
    if (abandoned) void revoke(abandoned).catch(() => { /* Server expiry bounds an interrupted logout. */ });
  }, []);
  const active = (id: number) => generation.current === id && !!token.current && Date.now() < deadline.current;
  function clearSession(message = '') {
    generation.current++; token.current = undefined; clearTimeout(expiry.current); clearTimeout(poll.current);
    setAuthenticated(false); setConnected(false); setCredentialCount(0); setWallets([]); setWalletId(''); setDeploymentStatus(''); setDeployment(null);
    lock.current = false; setBusy(false); onConnect(null); setError(message);
  }
  async function openWallet(selected: OwnedWallet, id: number) {
    const session = token.current;
    const adapter = await connectPaymentAdapter(apiClient(() => session), selected.id, signer);
    if (!active(id)) return;
    if (adapter.address !== selected.address) throw Error('Wallet identity changed. Reconnect to refresh your wallets.');
    onConnect(adapter); setCanSign(adapter.canSign !== false); setConnected(true);
  }
  async function loadDeployment(id: number, reserve = false) {
    clearTimeout(poll.current);
    if (!active(id)) return;
    const session = token.current;
    try {
      const value = await apiClient(() => session)('smart-account/deployment', reserve ? {} : undefined);
      if (!active(id)) return;
      const view = parseDeployment(value);
      setDeployment(view); setDeploymentStatus(view.status);
      if (view.enabled && ['PENDING','SUBMITTED'].includes(view.status)) {
        poll.current = setTimeout(() => { void loadDeployment(id); }, 5000);
      }
    } catch (e) {
      if (!active(id)) return;
      if (e instanceof ApiError && e.status === 401) { clearSession('Your session expired. Reconnect with your passkey.'); return; }
      setDeployment(null); setDeploymentStatus('UNAVAILABLE');
      setError('Provisioning status is unavailable. Your passkey profile remains connected. Refresh deployment status to retry.');
    }
  }
  async function loadWallets(id: number) {
    const session = token.current;
    let owned: OwnedWallet[];
    try { owned = await discoverWallets(apiClient(() => session)); }
    catch (e) {
      // A new primary-controlled contract may exist before payment/recovery activation.
      // Only this explicit disabled-runtime response is an empty discovery fallback.
      if (!(e instanceof ApiError && e.status === 503 && e.code === 'PAYMENT_INTEGRATION_NOT_CONFIGURED')) throw e;
      owned = [];
    }
    if (!active(id)) return;
    setWallets(owned); setWalletId(owned[0]?.id ?? ''); setDeploymentStatus(''); setDeployment(null);
    if (owned.length === 0) await loadDeployment(id, true);
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
    if (previous) { onConnect(null); setConnected(false); }
    clearTimeout(expiry.current); clearTimeout(poll.current); setDeploymentStatus(''); setDeployment(null);
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
    const id = ++generation.current, owner = email.trim().toLowerCase(); lock.current = true; setBusy(true); setError(''); setNotice('');
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
    const id = ++generation.current; clearTimeout(poll.current); lock.current = true; setBusy(true); setError(''); setNotice('');
    const api = apiClient(() => token.current);
    let verifying = false;
    try {
      const challenge = object(await api('passkeys/registration/options', additional ? { accountID: accountId } : { email: email.trim().toLowerCase() }));
      if (generation.current !== id) return;
      const owner = text(challenge.accountID);
      if (additional && owner !== accountId) throw Error('Enrollment account changed. Reconnect before trying again.');
      if (!additional) {
        setAccountId(owner);
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
  async function refreshDeployment() {
    if (lock.current || !active(generation.current)) return;
    const id = generation.current; lock.current = true; setBusy(true); setError('');
    try { await loadDeployment(id, deploymentStatus === 'NOT_STARTED'); }
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
    <p>Use your email address and passkey to find your Testnet wallet. Where automatic deployment is enabled, your verified primary passkey is bound to a new C-address. Registration never funds a wallet.</p>
    {authenticated ? <>
      <label htmlFor="profile-account-id">Account ID</label><input id="profile-account-id" value={accountId} readOnly/>
      <p>{credentialCount} {credentialCount === 1 ? 'passkey' : 'passkeys'} enrolled for sign-in.</p>
      {connected ? <><p role="status">Wallet connected.</p><p>{canSign ? 'Transaction approval connected.' : 'Transaction signing is not connected yet. You can inspect available wallet records.'}</p></> : busy ? <p role="status">Loading your wallets…</p> : wallets.length === 0 ? <>
        {deployment?.address ? <>
          <p role="status">C-address deployed. Your primary passkey signer binding is verified on Stellar Testnet.</p>
          <label htmlFor="deployed-contract">Deployed C-address</label><input id="deployed-contract" value={deployment.address} readOnly/>
          <p>Deployment ledger: {deployment.ledger}. <a href={`https://stellar.expert/explorer/testnet/tx/${deployment.transactionHash}`} target="_blank" rel="noreferrer">View deployment transaction</a></p>
          <p>Payments and funding instructions remain unavailable until an independent backup is enrolled on-chain and recovery is verified.</p>
        </> : <p role="status">No deployed C-address wallet is linked to this account yet. Provisioning status: {deploymentStatus || 'NOT_STARTED'}. {deployment?.enabled ? 'Automatic Testnet deployment is processing; confirmation and signer verification are required.' : 'Deployment status has not been verified. Do not fund a predicted address.'}</p>}
        <button className="secondary-button" disabled={busy} onClick={() => void refreshDeployment()}>Refresh deployment status</button>
      </> : <form onSubmit={e => void choose(e)}><fieldset disabled={busy}><label htmlFor="owned-wallet">Choose your wallet</label><select id="owned-wallet" value={walletId} onChange={e => setWalletId(e.target.value)}>{wallets.map(w => <option key={w.id} value={w.id}>{w.address}</option>)}</select><button type="submit">Open wallet</button></fieldset></form>}
      <p>Add an independent passkey on another device or security key. Off-chain enrollment alone does not add a backup on-chain signer or verify recovery.</p>
      <button disabled={busy} onClick={() => void register(true)}>Add another passkey</button>
      <button className="secondary-button" onClick={() => void disconnect()}>Disconnect wallet</button>
    </> : <>
      <form onSubmit={e => void connect(e)}><fieldset disabled={busy}><label htmlFor="account-id">Email address (Account ID)</label><input id="account-id" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email"/><button type="submit">{busy ? 'Please wait…' : 'Connect with passkey'}</button></fieldset></form>
      <button className="secondary-button" disabled={busy} onClick={() => void register(false)}>Create passkey profile</button>
      <p>New here? Create a profile, save its account ID, then add another passkey. Your device manages the passkeys.</p>
    </>}
    {accountId && <button className="secondary-button" onClick={() => void copyAccount()}>Copy account ID</button>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
