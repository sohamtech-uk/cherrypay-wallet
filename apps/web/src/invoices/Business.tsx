import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ReceiptText, RefreshCw } from 'lucide-react';
import { usePayments } from '../payments/context';
import { NETWORK, xlm, type Invoice, type InvoiceReceipt, type PaymentAdapter } from '../payments/model';

export function Business() {
  const adapter = usePayments();
  return <>
    <div className="heading"><div><span className="eyebrow">GET PAID</span><h1>Business dashboard</h1><p>Payment links, invoices and receipts in one place.</p></div><Link className="primary-link" to="/invoices?create=1"><ReceiptText size={17}/> Create invoice</Link></div>
    {adapter?.network === NETWORK && adapter.invoices ? <BusinessOverview key={adapter.address} adapter={adapter}/> : <section className="card"><h2>Connect your business wallet</h2><p>Use your wallet to create invoice QR codes and match incoming payments.</p><Link className="secondary-button" to="/onboarding">Set up wallet</Link></section>}
  </>;
}

function BusinessOverview({ adapter }: { adapter: PaymentAdapter }) {
  const [data, setData] = useState<{ invoices: Invoice[]; receipts: InvoiceReceipt[]; moreInvoices: boolean; moreReceipts: boolean }>();
  const [error, setError] = useState(''), [busy, setBusy] = useState(true), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setBusy(true); setError('');
    void Promise.all([adapter.invoices!.list(), adapter.invoices!.unmatched()]).then(([invoices, receipts]) => {
      if (invoices.items.some(i => i.network !== NETWORK || i.destination !== adapter.address)) throw Error('Wallet mismatch');
      invoices.items.forEach(i => { xlm(i.amountStroops); xlm(i.remainingStroops); xlm(i.paidStroops); });
      if (active) setData({ invoices: invoices.items, receipts: receipts.items, moreInvoices: !!invoices.nextCursor, moreReceipts: !!receipts.nextCursor });
    }).catch(() => { if (active) { setData(undefined); setError('Unable to load your business overview. Try refreshing.'); } }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [adapter, refresh]);
  const invoices = data?.invoices ?? [];
  const received = invoices.reduce((total, i) => total + BigInt(i.paidStroops), 0n);
  const outstanding = invoices.reduce((total, i) => total + BigInt(i.remainingStroops), 0n);
  return <div className="business-home">
    <div className="section-toolbar"><p>{data ? `Summary of ${invoices.length} latest invoices${data.moreInvoices ? ' · more in Invoices' : ''}. Includes expired invoices.` : 'Your invoice summary'}</p><button className="secondary-button" disabled={busy} onClick={() => setRefresh(n => n + 1)}><RefreshCw size={16}/> Refresh business overview</button></div>
    {busy && <p role="status">Loading business overview…</p>}{error && <p role="alert" className="error">{error}</p>}
    <div className="summary-grid">
      <section className="card metric-card"><span>Received against invoices</span><strong>{data ? xlm(received.toString()) : '—'} <small>XLM</small></strong><p>Verified and allocated payments</p></section>
      <section className="card metric-card"><span>Still to collect</span><strong>{data ? xlm(outstanding.toString()) : '—'} <small>XLM</small></strong><p>Outstanding on these invoices</p></section>
      <section className="card metric-card"><span>Receipts to review</span><strong>{data ? `${data.receipts.length}${data.moreReceipts ? '+' : ''}` : '—'}</strong><p>Unmatched incoming transfers</p></section>
    </div>
    <section className="card"><div className="wallet-card-heading"><h2>Recent invoices</h2><Link className="text-link" to="/invoices">View all invoices <ArrowUpRight size={16}/></Link></div>
      {data && !invoices.length && <div className="empty-state"><ReceiptText size={30}/><h3>Your first invoice starts here</h3><p>Create a payment link or QR with a reference and exact XLM amount.</p><Link className="primary-link" to="/invoices?create=1">Create your first invoice</Link></div>}
      <ul className="invoice-summary-list">{invoices.slice(0, 5).map(i => <li key={i.id}><Link to={`/invoices?invoice=${encodeURIComponent(i.id)}`}><div><strong>{i.invoiceReference}</strong><small>{i.merchantName}</small></div><div><strong>{xlm(i.amountStroops)} XLM</strong><small className="state-label">{i.paymentPending ? 'Payment processing' : i.status.replaceAll('_', ' ')}{i.expired ? ' · expired' : ''}</small></div></Link></li>)}</ul>
    </section>
    <div className="quick-grid"><section className="card"><h2>Reconcile receipts</h2><p>Invoice QR payments match automatically. Assign address-only receipts after checking your records.</p><Link className="secondary-button" to="/invoices">Review invoices & receipts</Link></section><section className="card"><h2>Pay your team</h2><p>Prepare a pay run and review each wallet payment before approving it.</p><Link className="secondary-button" to="/payroll">Open payroll</Link></section></div>
  </div>;
}
