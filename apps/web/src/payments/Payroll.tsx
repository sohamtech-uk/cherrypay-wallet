import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePayments } from './context';
import { checkQuote, destinationError, explorerLink, paymentBreakdown, statusLabel, stroops, xlm, type PayRun, type PayRunSummary, type PaymentAdapter, type Quote } from './model';

export function Payroll() {
  const adapter = usePayments();
  return adapter?.payroll && adapter.canSign !== false ? <PayRunScreen key={adapter.address} adapter={adapter}/> : <section className="card payment-screen"><h1>Testnet payroll</h1><p>Connect a verified smart wallet to create and approve XLM pay runs.</p><Link to="/onboarding">Set up wallet</Link></section>;
}
export function parseRecipients(value: string, adapter: PaymentAdapter) {
  const lines = value.trim().split(/\r?\n/);
  if (lines.length < 1 || lines.length > 50) throw Error('Enter between 1 and 50 recipients.');
  const items = lines.map(line => {
    const fields = line.split(',').map(v => v.trim());
    if (fields.length !== 3 || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(fields[0])) throw Error('Each line needs a unique reference, Stellar address and XLM amount, separated by commas.');
    const [reference,destination,value] = fields;
    const invalid = destinationError(destination, adapter.supportedDestinations);
    if (invalid || destination === adapter.address) throw Error(invalid || 'The paying wallet cannot be a recipient.');
    const amount = stroops(value); if (amount <= 0n) throw Error('Each amount must be greater than zero.');
    return { reference, destination, amountStroops: amount.toString() };
  });
  if (new Set(items.map(i => i.reference)).size !== items.length || new Set(items.map(i => i.destination)).size !== items.length) throw Error('Recipient references and addresses must be unique within a pay run.');
  return items;
}
/** Resolve optional verified-email aliases, then persist ONLY immutable addresses and amounts. */
export async function resolvePayrollRecipients(value: string, adapter: PaymentAdapter) {
  const lines = value.trim().split(/\r?\n/);
  if (lines.length < 1 || lines.length > 50) throw Error('Enter between 1 and 50 recipients.');
  const aliases: Record<string,string> = {};
  const resolved: string[] = [];
  for (const line of lines) {
    const fields = line.split(',').map(v => v.trim());
    if (fields.length !== 3) throw Error('Each line needs reference, verified email or Stellar address, and XLM amount.');
    const [reference,destination,amount] = fields;
    if (destination.includes('@')) {
      if (!adapter.resolveRecipientEmail) throw Error('Pay-by-email directory is unavailable.');
      const found = await adapter.resolveRecipientEmail(destination);
      if (!found.mailboxVerified || !found.walletBindingVerified || found.legalIdentityVerified !== false)
        throw Error('Recipient email could not be verified.');
      aliases[reference] = found.email;
      resolved.push([reference,found.address,amount].join(','));
    } else resolved.push(line);
  }
  return {items:parseRecipients(resolved.join('\n'),adapter),aliases};
}
function PayRunScreen({ adapter }: { adapter: PaymentAdapter }) {
  const payroll = adapter.payroll!;
  const [runs, setRuns] = useState<PayRunSummary[]>([]), [cursor, setCursor] = useState<string>();
  const [current, setCurrent] = useState<PayRun>(), [reference, setReference] = useState(''), [recipients, setRecipients] = useState('');
  const [quote, setQuote] = useState<Quote>(), [accepted, setAccepted] = useState(false);
  const [aliases,setAliases] = useState<Record<string,string>>({});
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const mutex = useRef(false), epoch = useRef(0);
  useEffect(() => {
    const version = ++epoch.current;
    setCurrent(undefined); setQuote(undefined); setAccepted(false); setRuns([]); setCursor(undefined); setAliases({});
    payroll.list().then(page => { if (epoch.current === version) { setRuns(page.items); setCursor(page.nextCursor); } }).catch(e => { if (epoch.current === version) setError(e.message); });
    return () => { epoch.current = version + 1; };
  }, [payroll]);
  async function act(work: (live: () => boolean) => Promise<void>) {
    if (mutex.current) return;
    const version = epoch.current, live = () => version === epoch.current;
    mutex.current = true; setBusy(true); setError('');
    try { await work(live); } catch (e) { if (live()) setError((e instanceof Error ? e.message : 'Request unavailable.') + ' Refresh this pay run before taking another action.'); }
    finally { mutex.current = false; if (live()) setBusy(false); }
  }
  return <section className="card payment-screen"><span className="eyebrow">STELLAR TESTNET · XLM</span><h1>Payroll pay runs</h1>
    <p>Create a saved list of payments, then review and approve each recipient separately. Recipients can be entered by Stellar address or verified, opted-in Cherry Wallet email. This pilot sends Testnet XLM; it does not calculate salaries, taxes or deductions.</p>
    <p role="alert">{error}</p>
    {!current && <form onSubmit={e => { e.preventDefault(); void act(async live => {
      const recipientsResolved = await resolvePayrollRecipients(recipients,adapter);
      const input = { network: 'TESTNET' as const, reference, maxFeeStroops: '10000000', items: recipientsResolved.items };
      const saved = await payroll.create(input); if (live()) { setCurrent(saved); setQuote(undefined); setAccepted(false); setAliases(recipientsResolved.aliases); }
    }); }}><fieldset disabled={busy}><legend>New pay run</legend>
      <label htmlFor="payrun-reference">Unique pay run reference</label><input id="payrun-reference" required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" value={reference} onChange={e => setReference(e.target.value)}/>
      <label htmlFor="payrun-recipients">Recipients: reference, Stellar address or verified email, XLM amount</label><textarea id="payrun-recipients" rows={6} maxLength={10000} required value={recipients} onChange={e => setRecipients(e.target.value)} aria-describedby="payrun-help"/>
      <p id="payrun-help">One recipient per line, up to 50. Email aliases must be opted in and verified. Use internal references, not personal names. No header row. Only compatible Testnet wallets without memos are supported. A saved reference cannot be reused for changed payments.</p>
      <button type="submit">Save pay run</button></fieldset></form>}
    {current && <section aria-label="Saved pay run"><h2>{current.reference}</h2><p>{current.confirmedCount} of {current.items.length} verified · Total {xlm(current.totalStroops)} XLM</p>
      <p>Maximum network fee allowance per payment: {xlm(current.maxFeeStroops)} XLM, paid by the sponsor. Across {current.items.length} lines, the maximum aggregate sponsored fee allowance is {xlm((BigInt(current.maxFeeStroops) * BigInt(current.items.length)).toString())} XLM. The actual fee may be lower. No Cherry Wallet platform fee is charged. Payments settle individually and may complete partially.</p>
      <p>PAYE, National Insurance, pension, employer costs and FX conversion are NOT calculated here. This is Testnet XLM disbursement, not a payroll tax computation or real salary payment.</p>
      <button disabled={busy} onClick={() => void act(async live => { setQuote(undefined); setAccepted(false); const value = await payroll.get(current.id); if (live()) setCurrent(value); })}>Refresh pay run</button>
      <div className="payroll-table"><table><thead><tr><th>Reference / recipient</th><th>XLM</th><th>Status</th><th>Action</th></tr></thead><tbody>{current.items.map(row => <tr key={row.reference}>
        <td>{row.reference}{aliases[row.reference]&&<small className="payroll-address">Verified email: {aliases[row.reference]} (not legal identity)</small>}<small className="payroll-address">{row.destination}</small></td><td>{xlm(row.amountStroops)}</td><td>{row.attempt ? statusLabel(row.attempt) : 'Not prepared'}</td><td>
          {(!row.attempt || row.attempt.status === 'awaiting_approval') && <button disabled={busy || !!quote} onClick={() => void act(async live => {
            setQuote(undefined); setAccepted(false);
            const a = await payroll.prepare(current.id, row.reference);
            if (!live()) return;
            if (a.destination !== row.destination || a.amountStroops !== row.amountStroops) throw Error('Payment differs from saved recipient.');
            const updated = await payroll.get(current.id); if (!live()) return; setCurrent(updated);
            if (a.status !== 'awaiting_approval') return;
            if (!adapter.getQuote) throw Error('Payment preview is unavailable.');
            const q = await adapter.getQuote(a.id);
            checkQuote(q, { network: 'TESTNET', from: adapter.address, destination: row.destination, amountStroops: row.amountStroops });
            if (q.id !== a.id || q.feeStroops !== current.maxFeeStroops) throw Error('Payment fee or identity mismatch.');
            if (live()) setQuote(q);
          })}>Review payment</button>}
          {row.attempt && explorerLink(row.attempt) && <a href={explorerLink(row.attempt)} target="_blank" rel="noreferrer">Receipt</a>}
          {row.attempt && !explorerLink(row.attempt) && <Link to={`/history/${encodeURIComponent(row.attempt.id)}`}>Payment details</Link>}
        </td></tr>)}</tbody></table></div>
      {quote && <section aria-label="Review payroll payment"><h3>Approve this recipient</h3><dl><dt>Destination (actual Stellar address)</dt><dd>{quote.destination}</dd><dt>Recipient receives</dt><dd>{xlm(paymentBreakdown(quote).transferStroops)} XLM</dd><dt>Cherry Wallet platform fee</dt><dd>{xlm(paymentBreakdown(quote).serviceFeeStroops)} XLM</dd><dt>Maximum network fee allowance</dt><dd>{xlm(paymentBreakdown(quote).maximumNetworkFeeStroops)} XLM ({quote.feePayer === 'sponsor' ? 'sponsor pays' : 'wallet pays'})</dd><dt>Maximum wallet debit</dt><dd>{xlm(paymentBreakdown(quote).maximumWalletDebitStroops)} XLM</dd><dt>Expires</dt><dd>{new Date(quote.expiresAt).toLocaleString()}</dd></dl>
        <label><input type="checkbox" checked={accepted} disabled={busy} onChange={e => setAccepted(e.target.checked)}/> I checked this recipient, amount, maximum fee and Testnet network.</label>
        <button disabled={busy || !accepted} onClick={() => void act(async live => {
          const reviewed = quote;
          const target = current.items.find(row => row.destination === reviewed.destination && row.amountStroops === reviewed.amountStroops);
          if (target && aliases[target.reference]) {
            if (!adapter.resolveRecipientEmail) throw Error('Recipient email lookup unavailable. Do not approve.');
            const fresh = await adapter.resolveRecipientEmail(aliases[target.reference]);
            if (fresh.address !== target.destination) throw Error('Recipient wallet changed since payroll was prepared. Do not approve.');
          }
          setQuote(undefined); setAccepted(false);
          await adapter.approve(reviewed.id, reviewed);
          if (!live()) return; const updated = await payroll.get(current.id); if (live()) setCurrent(updated);
        })}>Approve with passkey</button>
        <button disabled={busy} onClick={() => void act(async live => {
          if (!adapter.cancelAttempt) throw Error('Cancellation unavailable.');
          await adapter.cancelAttempt(quote.id); if (!live()) return;
          setQuote(undefined); setAccepted(false); const updated = await payroll.get(current.id); if (live()) setCurrent(updated);
        })}>Cancel unsigned payment</button>
      </section>}
    </section>}
    <h2>Saved pay runs</h2><button disabled={busy} onClick={() => void act(async live => { const page = await payroll.list(); if (live()) { setRuns(page.items); setCursor(page.nextCursor); } })}>Refresh saved runs</button>
    <ul>{runs.map(r => <li key={r.id}><button disabled={busy} onClick={() => void act(async live => { const value = await payroll.get(r.id); if (live()) { setCurrent(value); setQuote(undefined); setAccepted(false); } })}>{r.reference} · {r.recipientCount} recipients</button></li>)}</ul>
    {cursor && <button disabled={busy} onClick={() => void act(async live => { const page = await payroll.list(cursor); if (live()) { setRuns(old => [...old,...page.items.filter(r => !old.some(o => o.id === r.id))]); setCursor(page.nextCursor); } })}>Load more runs</button>}
    {current && <button disabled={busy} onClick={() => { setCurrent(undefined); setQuote(undefined); setAccepted(false); setReference(''); setRecipients(''); setAliases({}); }}>New pay run</button>}
  </section>;
}
