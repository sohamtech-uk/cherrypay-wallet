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


function RouteContent({children, external}: {children: React.ReactNode; external: boolean}) {
  const account = useWalletAccount(), adapter = usePayments(), {pathname} = useLocation();
  if (account && !adapter && !external && !pathname.startsWith('/pay/') && !['/profile','/security','/developers','/api-docs'].includes(pathname) && (!account.authenticated || pathname !== '/receive')) return null;
  return children;
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
            showSetup={!external && !['/profile','/security'].includes(pathname) && (!connectedAdapter || pathname === '/onboarding')}><RouteContent external={external}>{screens}</RouteContent></PaymentConnection>
        : screens}
    </WalletShell>
  </PaymentContext.Provider>;
}
