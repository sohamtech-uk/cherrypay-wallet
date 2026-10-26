import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Eye, EyeOff, KeyRound, LockKeyhole, LogOut, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { usePayments } from './context';
import { useWalletAccount } from './account-context';
import { NETWORK } from './model';

export function Profile() {
  const account = useWalletAccount();
  const adapter = usePayments();
  const [showAddress, setShowAddress] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  if (!account?.authenticated) {
    return <div className="profile-page"><div className="heading"><div><span className="eyebrow">ACCOUNT</span><h1>Profile & settings</h1></div></div>
      <section className="card payment-screen"><h2>Sign in to your account</h2><p>Your wallet profile and security settings are available only after email and passkey authentication.</p><Link className="secondary-button" to="/">Go to wallet sign-in</Link></section></div>;
  }
  const address = adapter?.network === NETWORK ? adapter.address : account.deployment?.spendingEnabled ? account.deployment.address : null;
  const funded = account.deployment?.funding?.status === 'FUNDED';
  const funding = account.deployment?.funding;
  async function run(operation: () => Promise<void>) {
    setActionMessage('');
    try { await operation(); }
    catch { setActionMessage('The action could not be completed. Check your connection and try again.'); }
  }
  async function copyAddress() {
    if (!address) return;
    try { await navigator.clipboard.writeText(address); setCopyMessage('Full wallet address copied.'); }
    catch { setCopyMessage('Copy unavailable. Reveal the address to select and copy it manually.'); }
  }
  return <div className="profile-page">
    <div className="heading"><div><span className="eyebrow">MY ACCOUNT</span><h1>Profile & settings</h1><p>Manage your email identity, wallet and passkey security.</p></div></div>
    <section className="card payment-screen" aria-label="Account profile">
      <div className="profile-section-heading"><h2>Account information</h2><span className="wallet-pill">Email verified with passkey</span></div>
      <label htmlFor="profile-email">Email address / Account ID</label><input id="profile-email" value={account.accountId} readOnly/>
      <p>Your email is the wallet account identifier. Changing it requires a verified account-migration process and is not supported here.</p>
    </section>
    <section className="card payment-screen" aria-label="Wallet details">
      <div className="profile-section-heading"><h2><Wallet size={20}/> Wallet details</h2><span className="wallet-pill">Stellar Testnet</span></div>
      <dl className="profile-detail-grid"><dt>Connection</dt><dd>{account.connected ? 'Connected' : 'Not ready'}</dd><dt>Wallet status</dt><dd>{account.deployment?.spendingEnabled ? 'On-chain signer verified' : account.connected ? 'Connected; signer status not verified here' : account.deploymentStatus || 'Awaiting verification'}</dd><dt>Transaction approval</dt><dd>{account.connected && account.canSign ? 'Approval mode available (requires fresh passkey)' : 'Not available'}</dd></dl>
      {address ? <>
        <label htmlFor="profile-wallet-address">Wallet address</label>
        <div className="wallet-address-row"><input id="profile-wallet-address" className="mono" readOnly value={showAddress ? address : address.slice(0,5)+'••••••••'+address.slice(-5)} aria-label="Wallet address"/>
          <button className="secondary-button" type="button" aria-pressed={showAddress} onClick={() => setShowAddress(v => !v)}>{showAddress ? <EyeOff size={16}/> : <Eye size={16}/>} {showAddress ? 'Hide address' : 'Show address'}</button>
          <button className="secondary-button" type="button" onClick={() => void copyAddress()}><Copy size={16}/> Copy address</button></div>
        <p role="status">{copyMessage}</p>
      </> : <p role="status">A verified wallet address is not available yet. Do not fund a predicted address.</p>}
      <button className="secondary-button" type="button" disabled={account.busy} onClick={() => void run(account.refreshDeployment)}><RefreshCw size={16}/> Refresh wallet status</button>
    </section>
    <section className="card payment-screen" aria-label="Testnet funding settings">
      <h2>Testnet funding</h2>
      {funded ? <p role="status">Confirmed allocation: {funding?.amountXlm} Testnet XLM.</p>
       : funding?.status === 'PENDING' || funding?.status === 'SUBMITTED' ? <p role="status">Your funding request is pending verification. Please do not request another allocation.</p>
       : funding?.status === 'REVIEW_REQUIRED' || funding?.status === 'FAILED' ? <p role="alert">Funding needs operator review. Do not repeat the request.</p>
       : <p>One-time test funds are available only when funding is enabled and the C-wallet has been verified.</p>}
      {!funded && !['PENDING','SUBMITTED','REVIEW_REQUIRED','FAILED'].includes(funding?.status ?? '') && <button disabled={account.busy || !address || !funding} type="button" onClick={() => void run(account.fundTestnet)}>Fund Testnet wallet</button>}
    </section>
    <section className="card payment-screen" aria-label="Passkeys and security">
      <h2><KeyRound size={20}/> Passkeys & security</h2>
      <p>{account.credentialCount} {account.credentialCount === 1 ? 'passkey' : 'passkeys'} registered for sign-in.</p>
      <p><ShieldCheck size={16}/> Signing in with another passkey does not authorize wallet spending.</p>
      <p className="notice"><LockKeyhole size={16}/> <strong>Recovery warning:</strong> Without a separately configured and verified on-chain backup signer, losing your primary signing passkey can mean losing spending access. Email and an additional sign-in passkey alone cannot restore it.</p>
      <button disabled={account.busy} type="button" onClick={() => void run(account.addPasskey)}>Add another passkey</button>
      <Link className="secondary-button" to="/security">Security & recovery guidance</Link>
    </section>
    <section className="card payment-screen" aria-label="Account session">
      <h2>Session</h2><p>Passkey sessions expire within 30 minutes. Signing out removes authority from this browser session.</p>
      {account.error && <p role="alert" className="error">{account.error}</p>}
      {account.notice && <p role="status">{account.notice}</p>}
      {actionMessage && <p role="status">{actionMessage}</p>}
      <button className="secondary-button" type="button" onClick={() => void account.signOut()}><LogOut size={16}/> Sign out</button>
    </section>
  </div>;
}
