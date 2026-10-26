import { Payroll } from './payments/Payroll';
import { AuroraPayment } from './integrations/AuroraPayment';
import { RecipientIntelligence } from './integrations/RecipientIntelligence';
import { PaymentConnection } from './payments/Connection';
import { Profile } from './payments/Profile';
import type { TransferSigner } from './payments/api';
import { Recovery } from './payments/Recovery';
import { PaymentContext } from './payments/context';
import type { PaymentAdapter } from './payments/model';
import { Receive } from './payments/Receive';
import { Send } from './payments/Send';
import { History } from './payments/History';
import './payments/payments.css';
import { useEffect, useState } from 'react';
import { Overview } from './payments/Overview';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, CircleHelp, Clock3, KeyRound, LayoutDashboard, LockKeyhole, Settings2, ShieldAlert, Wallet } from 'lucide-react';


function TestnetTag() { return <span className="testnet" aria-label="Stellar Testnet only">● TESTNET ONLY</span>; }
function Shell({ children, externalNetwork }: { children: React.ReactNode; externalNetwork?: 'TESTNET' | 'MAINNET' }) {
  const { pathname } = useLocation();
  const mainnet = pathname === '/pay-from-another-chain' && externalNetwork === 'MAINNET';
  const intelligence = pathname === '/recipient-intelligence';
  const tag = mainnet ? <span className="mainnet-tag">MAINNET · REAL USDC</span> : intelligence ? <span className="read-only-tag">READ ONLY</span> : <TestnetTag/>;
  return <div className="app"><a className="skip-link" href="#wallet-content">Skip to content</a>
    <aside className="sidebar">
      <Link to="/" className="brand"><span className="brand-icon">✦</span><span>Cherry<span className="brand-accent">Wallet</span></span></Link>
      {tag}
      <nav aria-label="Wallet navigation">
        <NavLink end to="/" className={({isActive})=>isActive?'active':''}><LayoutDashboard size={19}/> Dashboard</NavLink>
        <NavLink to="/send" className={({isActive})=>isActive?'active':''}><ArrowUpRight size={19}/> Send</NavLink>
        <NavLink to="/receive" className={({isActive})=>isActive?'active':''}><ArrowDownLeft size={19}/> Receive</NavLink>
        <NavLink to="/history" className={({isActive})=>isActive?'active':''}><Clock3 size={19}/> Activity</NavLink>
        <NavLink to="/profile" className={({isActive})=>isActive?'active':''}><Settings2 size={19}/> Profile & settings</NavLink>
        <details className="nav-more"><summary>More services</summary>
          <NavLink to="/onboarding">Wallet setup</NavLink><NavLink to="/security">Security & recovery</NavLink>
          <NavLink to="/payroll">Payroll</NavLink><NavLink to="/pay-from-another-chain">Pay from another chain</NavLink>
          <NavLink to="/recipient-intelligence">Recipient intelligence</NavLink>
        </details>
      </nav>
      <div className="sidebar-bottom"><ShieldAlert size={17}/> {mainnet ? 'Base → Stellar mainnet. Real USDC.' : intelligence ? 'Recipient checks do not authorize payments.' : 'Testnet funds have no real-world value.'}</div>
    </aside>
    <main className="main" id="wallet-content" tabIndex={-1}>
      <header className="topbar"><span>Cherry Pay · Wallet</span>{tag}</header>
      <div className="content">{children}</div>
    </main>
  </div>;
}
function SetupCard() { return <section className="card payment-screen"><span className="eyebrow">START HERE</span><h1>Set up your Testnet wallet</h1><div className="steps"><div><span>01</span><strong>Sign in with your email and passkey</strong><small>Your device creates a sign-in passkey the first time. Wallet spending additionally requires its verified on-chain signer binding.</small></div><div><span>02</span><strong>Create and fund your C-wallet</strong><small>If automatic deployment is enabled, the service deploys your smart wallet and verifies its signer. Wait for confirmation before funding. Funding requires operator configuration.</small></div><div><span>03</span><strong>Send and receive Testnet XLM</strong><small>Share your C-address to receive supported transfers. Review the recipient and amount, then approve each send with your primary passkey.</small></div></div><p>Wallet readiness depends on successful deployment and payment-service activation. Sending requires sufficient balance. Testnet XLM has no real-world value.</p><Link className="secondary-button" to="/receive">Receive XLM</Link> <Link className="secondary-button" to="/send">Send XLM</Link><p className="notice"><LockKeyhole size={16}/> Your device manages passkeys. Never share private keys or seed phrases.</p></section>; }
function Security() { return <section className="card payment-screen"><span className="eyebrow">SECURITY</span><h1>Security & recovery</h1><h2>Your passkey profile</h2><p>Open Profile & settings to review your enrolled passkeys and add another sign-in credential.</p><div className="security-row"><KeyRound size={22}/><div><strong>Sign-in and payment approval</strong><small>Each payment requires your primary passkey to approve its exact recipient, amount and maximum fee. Signing in does not authorize a payment.</small></div></div><div className="security-row"><LockKeyhole size={22}/><div><strong>Independent wallet recovery</strong><small>Automatic wallets start with one on-chain primary signer. Adding another sign-in passkey does not make it a wallet signer or establish recovery. A separate on-chain backup signer and a successful recovery check are required before backup recovery can be claimed.</small></div></div><p>Keep access to your primary passkey. Another enrolled passkey can restore your profile session, but it cannot spend from your wallet unless it is also an authorized on-chain signer. An email address alone cannot restore spending access.</p><p>Sessions expire after at most 30 minutes. Refreshing this page requires a new passkey sign-in. Disconnect removes this browser session’s authority.</p><p className="notice"><CircleHelp size={16}/> Never enter seed phrases or private keys into this application.</p></section>; }
export default function App({ paymentAdapter, signer }: { paymentAdapter?: PaymentAdapter | null; signer?: TransferSigner } = {}) {
  const { pathname } = useLocation();
  const external = ['/pay-from-another-chain', '/recipient-intelligence'].includes(pathname);
  const [externalNetwork, setExternalNetwork] = useState<'TESTNET' | 'MAINNET'>();
  const [connectedAdapter, setConnectedAdapter] = useState<PaymentAdapter | null>(null);
  useEffect(() => {
    document.title = pathname === '/pay-from-another-chain' && externalNetwork === 'MAINNET'
      ? 'Cherry Wallet — Mainnet USDC'
      : pathname === '/recipient-intelligence' ? 'Cherry Wallet — Read-only recipient intelligence' : 'Cherry Pay Wallet — Testnet';
  }, [pathname, externalNetwork]);

  const screens = <Recovery><Routes>
    <Route path="/pay-from-another-chain" element={<AuroraPayment onNetwork={setExternalNetwork}/>}/>
    <Route path="/recipient-intelligence" element={<RecipientIntelligence/>}/>
    <Route path="/" element={<Overview/>}/>
    <Route path="/profile" element={<Profile/>}/>
    <Route path="/onboarding" element={<SetupCard/>}/>
    <Route path="/security" element={<Security/>}/>
    <Route path="/receive" element={<Receive/>}/>
    <Route path="/send" element={<Send/>}/>
    <Route path="/payroll" element={<Payroll/>}/>
    <Route path="/history" element={<History/>}/>
    <Route path="/history/:attemptId" element={<History/>}/>
    <Route path="*" element={<div className="card"><h1>Page not found</h1><Link to="/">Return to wallet</Link></div>}/>
  </Routes></Recovery>;
  return <PaymentContext.Provider value={paymentAdapter === undefined ? connectedAdapter : paymentAdapter}>
    <Shell externalNetwork={externalNetwork}>
      {paymentAdapter === undefined
        ? <PaymentConnection onConnect={setConnectedAdapter} signer={signer} showAccountActions={false}
            showSetup={!external && pathname !== '/profile' && !connectedAdapter}>{screens}</PaymentConnection>
        : screens}
    </Shell>
  </PaymentContext.Provider>;
}
