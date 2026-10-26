import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { usePayments } from '../payments/context';
import { NETWORK, stroops, xlm, type Invoice, type InvoiceDetail, type InvoiceInput, type InvoiceReceipt } from '../payments/model';

export function Invoices() {
  const adapter=usePayments();
  return adapter?.invoices?<InvoiceManager key={adapter.address}/>:<section className="card payment-screen"><h1>Invoices</h1><p>Connect your Testnet wallet to create invoice payment links and reconcile receipts.</p><Link to="/onboarding">Set up wallet</Link></section>;
}
function InvoiceManager() {
  const adapter=usePayments()!,api=adapter.invoices!;
  const [params] = useSearchParams();
  const [creating, setCreating] = useState(params.get('create') === '1');
  const [filter, setFilter] = useState('all');
  const requestedId = params.get('invoice');
  const [items,setItems]=useState<Invoice[]>([]),[next,setNext]=useState<string>();
  const [receipts,setReceipts]=useState<InvoiceReceipt[]>([]),[receiptNext,setReceiptNext]=useState<string>();
  const [selected,setSelected]=useState<InvoiceDetail>(),[reference,setReference]=useState(''),[merchant,setMerchant]=useState(''),[amount,setAmount]=useState('');
  const [expiry,setExpiry]=useState(()=>new Date(Date.now()+7*86400000).toISOString().slice(0,16));
  const [eventId,setEventId]=useState(''),[note,setNote]=useState(''),[confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const mutex=useRef(false),draft=useRef<InvoiceInput|undefined>(undefined);
  const refresh=useCallback(async()=>{const [page,unmatched]=await Promise.all([api.list(),api.unmatched()]);setItems(page.items);setNext(page.nextCursor);setReceipts(unmatched.items);setReceiptNext(unmatched.nextCursor);},[api]);
  useEffect(()=>{let active=true;void Promise.all([api.list(),api.unmatched()]).then(([page,unmatched])=>{if(active){setItems(page.items);setNext(page.nextCursor);setReceipts(unmatched.items);setReceiptNext(unmatched.nextCursor);}}).catch(()=>{if(active)setError('Unable to load invoices. Refresh to try again.');});return()=>{active=false;};},[api]);
  useEffect(()=>{let active=true;if(requestedId){setSelected(undefined);void api.get(requestedId).then(r=>{if(active)setSelected(r);}).catch(()=>{if(active)setError('Unable to open that invoice. Select it from the list.');});}return()=>{active=false;};},[api,requestedId]);
  const selectedId=selected?.id;
  const detailHeading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{if(selectedId)detailHeading.current?.focus();},[selectedId]);
  useEffect(()=>{
    if(!selectedId)return;
    let active=true,inFlight=false;
    const id=selectedId,timer=setInterval(()=>{if(inFlight||mutex.current)return;inFlight=true;void api.get(id).then(r=>{if(active)setSelected(r);}).catch(()=>{if(active)setError('Invoice refresh failed. The last verified totals are shown.');}).finally(()=>{inFlight=false;});},5000);
    return()=>{active=false;clearInterval(timer);};
  },[api,selectedId]);
  async function run(work:()=>Promise<void>) {if(mutex.current)return;mutex.current=true;setBusy(true);setError('');setNotice('');try{await work();}catch(e){setError(e instanceof Error?e.message:'Invoice request failed.');}finally{mutex.current=false;setBusy(false);}}
  const url=selected?`${window.location.origin}/pay/${encodeURIComponent(selected.id)}`:'';
  return <section className="card payment-screen invoice-screen"><span className="eyebrow">STELLAR TESTNET</span><h1>Invoices & reconciliation</h1>
    <p>Share a payment link. Track the receipt. Match it to your invoice.</p><Link className="text-link" to="/business">← Business dashboard</Link>
    <p role="alert" className="error">{error}</p><p role="status">{notice}</p>
    <div className="section-toolbar"><h2>Payment requests</h2><button type="button" aria-expanded={creating} onClick={()=>setCreating(v=>!v)}>{creating ? 'Close invoice form' : 'New invoice'}</button></div>
    {creating&&<form onSubmit={e=>{e.preventDefault();void run(async()=>{
      const exact=stroops(amount);if(exact<=0n)throw Error('Enter an amount greater than zero.');
      const input:InvoiceInput={network:NETWORK,invoiceReference:reference.trim(),merchantName:merchant.trim(),amountStroops:exact.toString(),expiresAt:Date.parse(expiry+'Z')};
      // Keep the exact expiry when retrying a lost create response.
      draft.current=input;setSelected(await api.create(draft.current));await refresh();setNotice('Invoice saved. Share its payment link or QR.');setCreating(false);
    });}}><fieldset disabled={busy}><legend>Create invoice payment request</legend>
      <label htmlFor="merchant-name">Merchant name</label><input id="merchant-name" value={merchant} maxLength={100} required onChange={e=>setMerchant(e.target.value)}/>
      <label htmlFor="invoice-reference">Invoice reference</label><input id="invoice-reference" value={reference} maxLength={64} required onChange={e=>setReference(e.target.value)}/>
      <label htmlFor="invoice-amount">Invoice amount (Testnet XLM)</label><input id="invoice-amount" inputMode="decimal" value={amount} required onChange={e=>setAmount(e.target.value)}/>
      <label htmlFor="invoice-expiry">Payment link expiry (UTC, within 90 days)</label><input id="invoice-expiry" type="datetime-local" value={expiry} required onChange={e=>setExpiry(e.target.value)}/>
      <button type="submit">Create invoice QR</button>
    </fieldset></form>}
    <h2>Saved invoices</h2><label htmlFor="invoice-filter">Show invoices</label><select id="invoice-filter" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">All invoices</option><option value="outstanding">Outstanding</option><option value="paid">Paid / overpaid</option></select><p className="small-copy">Filter applies to loaded invoices.</p><button className="secondary-button" disabled={busy} onClick={()=>void run(refresh)}>Refresh invoices and receipts</button>
    {!items.length&&<p>No invoice requests loaded.</p>}
    <ul className="invoice-list">{items.filter(r=>filter==='all'||(filter==='outstanding'?r.remainingStroops!=='0':r.remainingStroops==='0')).map(r=><li key={r.id}><button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{setSelected(await api.get(r.id));setEventId('');setNote('');setConfirmed(false);})}>{r.invoiceReference} · {xlm(r.amountStroops)} XLM · {r.status.replaceAll('_',' ')}</button></li>)}</ul>
    {next&&<button disabled={busy} onClick={()=>void run(async()=>{const page=await api.list(next);setItems(old=>[...old,...page.items]);setNext(page.nextCursor);})}>Load more invoices</button>}
    {selected&&<section aria-label="Invoice reconciliation"><h2 ref={detailHeading} tabIndex={-1}>{selected.invoiceReference}</h2><p>{selected.merchantName} · {selected.status.replaceAll('_',' ')}</p>
      <p>Allocated: {xlm(selected.paidStroops)} / {xlm(selected.amountStroops)} XLM. Remaining: {xlm(selected.remainingStroops)} XLM.</p>
      {selected.paymentPending&&<p role="status">A payment is being resolved. Additional checkout payments are blocked.</p>}
      {selected.expired&&<p>This payment link has expired. Existing transfers can still be reconciled.</p>}
      <div className="receive-qr"><QRCodeSVG value={url} size={224} level="M" title={`Pay invoice ${selected.invoiceReference}`}/></div>
      <label htmlFor="invoice-link">Invoice payment link</label><input id="invoice-link" value={url} readOnly/>
      <button className="secondary-button" onClick={()=>void run(async()=>{await navigator.clipboard.writeText(url);setNotice('Invoice payment link copied.');})}>Copy invoice link</button>
      <p className="small-copy">The payer reviews the invoice and approves with their passkey.</p>
      <h3>Allocated receipts</h3>{!selected.receipts.length&&<p>No verified payments allocated yet.</p>}
      <ul>{selected.receipts.map(r=><li key={r.eventId}>{xlm(r.amountStroops)} XLM · {r.method}{r.late?' · received after expiry':''}<br/><a href={`https://stellar.expert/explorer/testnet/tx/${r.transactionHash}`} target="_blank" rel="noreferrer">Verified transaction</a><p className="mono">{r.eventId}</p><p>{r.note}</p></li>)}</ul>
      {selected.receiptsTruncated&&<p>Showing the first 100 allocations. Totals include all receipts.</p>}
      <details className="disclosure reconciliation-tools"><summary>Assign an unmatched receipt</summary><p>Use your invoice records to confirm this payment belongs here. Matching amounts alone do not establish an invoice match. Full receipts are allocated once; partial and excess payments remain visible.</p>
      <form onSubmit={e=>{e.preventDefault();void run(async()=>{if(!confirmed)throw Error('Confirm the invoice match first.');setSelected(await api.allocate(selected.id,eventId,note));setEventId('');setNote('');setConfirmed(false);await refresh();});}}><fieldset disabled={busy}>
        <label htmlFor="receipt">Verified incoming receipt</label><select id="receipt" value={eventId} required onChange={e=>{setEventId(e.target.value);setConfirmed(false);}}><option value="">Select a receipt</option>{receipts.map(r=><option value={r.eventId} key={r.eventId}>{xlm(r.amountStroops)} XLM · {r.transactionHash.slice(0,12)} · event {r.eventId.split(':').slice(-2).join(':')}</option>)}</select>
        {eventId&&<p className="mono">{eventId}</p>}
        <label htmlFor="allocation-note">Evidence / reconciliation note</label><textarea id="allocation-note" value={note} minLength={5} maxLength={500} required onChange={e=>setNote(e.target.value)}/>
        <label className="check-label"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> I have verified this receipt belongs to this invoice. This allocation is recorded in the audit trail.</label>
        <button disabled={!confirmed||!eventId}>Assign receipt to invoice</button>
      </fieldset></form>
      {receiptNext&&<button disabled={busy} onClick={()=>void run(async()=>{const p=await api.unmatched(receiptNext);setReceipts(old=>[...old,...p.items]);setReceiptNext(p.nextCursor);})}>Load more unmatched receipts</button>}
      </details>
    </section>}
  </section>;
}
