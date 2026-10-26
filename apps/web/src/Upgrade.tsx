import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, Crown, X } from 'lucide-react';

const bannerKey = 'cherrypay:upgrade-banner:v1';
export function UpgradeBanner() {
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(bannerKey) === 'hidden'; } catch { return false; } });
  if (dismissed) return null;
  return <section className="upgrade-banner card" aria-label="Cherry Pay upgrades">
    <div className="tier-symbols" aria-hidden="true"><span><Crown/></span><span><Crown/></span><span><Crown/></span></div>
    <div><span className="eyebrow">GROW WITH CHERRY PAY</span><h2>A little more from your wallet.</h2><p>Explore what’s here today and what’s next for personal and business payments.</p></div>
    <Link className="primary-link" to="/upgrade">Explore upgrades <ArrowRight size={16}/></Link>
    <button className="banner-dismiss" aria-label="Dismiss upgrade banner" onClick={() => { setDismissed(true); try { localStorage.setItem(bannerKey, 'hidden'); } catch { /* Dismiss for this visit when storage is unavailable. */ } }}><X size={16}/></button>
  </section>;
}

const plans = [
  {name: 'Essential', style: 'essential', description: 'Your everyday Testnet wallet.', status: 'Available now', price: 'Free', features: ['Passkey sign-in and C-address wallet', 'Send and receive Testnet XLM', 'One-time 10,000 Testnet XLM allocation', 'Invoice QR links and payment matching', 'Activity, receipts and CSV export'], note: 'Network and service availability still apply.'},
  {name: 'Plus', style: 'plus', description: 'More ways to manage your money.', status: 'Plan preview', price: 'Coming soon', features: ['Proposed: additional supported assets', 'Proposed: richer spending insights', 'Proposed: saved payment contacts', 'Proposed: priority support'], note: 'Benefits and pricing are being defined.'},
  {name: 'Business', style: 'business', description: 'Built around your team’s payments.', status: 'Plan preview', price: 'Coming soon', features: ['Proposed: team roles and approvals', 'Proposed: accounting integrations', 'Proposed: advanced reconciliation reports', 'Proposed: dedicated onboarding'], note: 'The existing Testnet business dashboard remains free.'},
] as const;

export function Upgrade() {
  return <div className="upgrade-page">
    <div className="heading"><div><span className="eyebrow">CHERRY PAY UPGRADE</span><h1>A wallet that grows with you.</h1><p>Start with Essential. Discover the direction for Plus and Business.</p></div><span className="wallet-pill">Current release · Testnet</span></div>
    <p className="upgrade-disclosure">Plus and Business are previews, not active subscriptions. No payment is collected, and no paid benefits are enabled. Testnet XLM has no monetary value and cannot purchase a plan.</p>
    <div className="tier-grid">{plans.map(plan => <section className={`card tier-card ${plan.style}`} key={plan.name}>
      <div className="tier-card-top"><span className="tier-emblem"><Crown size={28}/></span><span className="wallet-pill">{plan.status}</span></div>
      <h2>Cherry Pay {plan.name}</h2><p>{plan.description}</p><div className="tier-price">{plan.price}</div>
      {plan.style === 'essential' ? <Link to="/" className="primary-link">Open wallet <ArrowRight size={16}/></Link> : <a className="secondary-button" href={`#${plan.style}-details`}>Explore proposed benefits <ArrowRight size={16}/></a>}
      <ul id={`${plan.style}-details`}>{plan.features.map(feature => <li key={feature}><Check size={16}/><span>{feature}</span></li>)}</ul><p className="small-copy">{plan.note}</p>
    </section>)}</div>
    <section className="card upgrade-faq"><h2>Good to know</h2><details><summary>Do I need to upgrade to send or receive?</summary><p>No. Available Testnet payments, invoices and the business dashboard remain part of the free experience. Each payment still requires your passkey approval.</p></details><details><summary>How will paid upgrades work?</summary><p>Pricing, eligibility, billing and final benefits will be published before activation is offered. This preview does not change your account or charge your wallet.</p></details><details><summary>Does a plan change wallet security or recovery?</summary><p>No. Passkey approval and on-chain signer requirements apply to everyone. A subscription cannot replace an authorized signer or recover a lost signing key.</p><Link className="text-link" to="/security">Read about wallet security</Link></details></section>
  </div>;
}
