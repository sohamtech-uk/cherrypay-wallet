import { Payroll } from './payments/Payroll';
import { WalletShell } from './WalletShell';
import { ApiReference } from './developers/ApiReference';
import { Business } from './invoices/Business';
import { useWalletAccount } from './payments/account-context';
import { usePayments } from './payments/context';
import { AuroraPayment } from './integrations/AuroraPayment';
import { RecipientIntelligence } from './integrations/RecipientIntelligence';
import { PaymentConnection } from './payments/Connection';
import { Profile } from './payments/Profile';
import type { TransferSigner } from './payments/api';
import { Recovery } from './payments/Recovery';
import { PaymentContext } from './payments/context';
import type { PaymentAdapter } from './payments/model';
import { Receive } from './payments/Receive';
import { Invoices } from './invoices/Invoices';
import { InvoiceCheckout } from './invoices/Checkout';
import { Send } from './payments/Send';
import { History } from './payments/History';
import './payments/payments.css';
import { useEffect, useState } from 'react';
import { Overview } from './payments/Overview';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { CircleHelp, KeyRound, LockKeyhole } from 'lucide-react';


function TestnetTag() { return <span className="testnet" aria-label="Stellar Testnet only">● TESTNET ONLY</span>; }
function Shell({ children, externalNetwork }: { children: React.ReactNode; externalNetwork?: 'TESTNET' | 'MAINNET' }) {
  const { pathname } = useLocation();
  const mainnet = pathname === '/pay-from-another-chain' && externalNetwork === 'MAINNET';
  const intelligence = pathname === '/recipient-intelligence';
  const tag = mainnet ? <span className="mainnet-tag">MAINNET · REAL USDC</span> : intelligence ? <span className="read-only-tag">READ ONLY</span> : <TestnetTag/>;
  return <div className="wallet-site"><a className="skip-link" href="#wallet-content">Skip to content</a>
    <SiteHeader/>
    <div className="app">
    <aside className="sidebar">
      <Link to="/" className="brand"><span className="brand-icon">✦</span><span>Cherry<span className="brand-accent">Wallet</span></span></Link>
      {tag}
      <nav aria-label="Wallet navigation">
        <NavLink end to="/" className={({isActive})=>isActive?'active':''}><LayoutDashboard size={19}/> Dashboard</NavLink>
        <NavLink to="/send" className={({isActive})=>isActive?'active':''}><ArrowUpRight size={19}/> Send</NavLink>
        <NavLink to="/receive" className={({isActive})=>isActive?'active':''}><ArrowDownLeft size={19}/> Receive</NavLink>
        <NavLink to="/invoices" className={({isActive})=>isActive?'active':''}><Clock3 size={19}/> Invoices</NavLink>
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
    </div>
    <SiteFooter/>
  </div>;
}
function SetupCard() { return <section className="card payment-screen"><h1>Ready for your first payment?</h1><p>Receive XLM using your wallet address, or review and approve a payment with your passkey.</p><div className="actions"><Link className="primary-link" to="/">Open dashboard</Link><Link className="secondary-button" to="/receive">Receive XLM</Link></div></section>; }
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
    <Route path="/developers" element={<ApiReference/>}/>
    <Route path="/api-docs" element={<ApiReference/>}/>
    <Route path="/receive" element={<Receive/>}/>
    <Route path="/business" element={<Business/>}/>
    <Route path="/invoices" element={<Invoices/>}/>
    <Route path="/pay/:requestId" element={<InvoiceCheckout/>}/>
    <Route path="/send" element={<Send/>}/>
    <Route path="/payroll" element={<Payroll/>}/>
    <Route path="/history" element={<History/>}/>
    <Route path="/history/:attemptId" element={<History/>}/>
    <Route path="*" element={<div className="card"><h1>Page not found</h1><Link to="/">Return to wallet</Link></div>}/>
  </Routes></Recovery>;
  return <PaymentContext.Provider value={paymentAdapter === undefined ? connectedAdapter : paymentAdapter}>
    <WalletShell externalNetwork={externalNetwork}>
      {paymentAdapter === undefined
        ? <PaymentConnection onConnect={setConnectedAdapter} signer={signer} showAccountActions={false}
            showSetup={!external && !['/profile','/security','/developers','/api-docs'].includes(pathname) && (!connectedAdapter || pathname === '/onboarding')}><RouteContent external={external}>{screens}</RouteContent></PaymentConnection>
        : screens}
    </WalletShell>
  </PaymentContext.Provider>;
}
