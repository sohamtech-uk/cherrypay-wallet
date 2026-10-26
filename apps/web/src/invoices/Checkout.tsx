import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiClient } from '../payments/api';
import { usePayments } from '../payments/context';
import { Send } from '../payments/Send';
import { xlm, type Invoice } from '../payments/model';
import { parseInvoice } from './api';

export function InvoiceCheckout() {
  const {requestId=''}=useParams(),adapter=usePayments();
  const [invoice,setInvoice]=useState<Invoice>(),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{
    let active=true,inFlight=false;
    setInvoice(undefined);setError('');
    const read=async()=>{
      if(inFlight)return;inFlight=true;
      try {
        if(!/^[a-f0-9-]{36}$/.test(requestId))throw Error('Invalid payment link.');
        const r=parseInvoice(await apiClient(()=>undefined)(`payment-requests/${encodeURIComponent(requestId)}`));
        if(r.id!==requestId)throw Error('Payment request identity mismatch.');
        if(active){setInvoice(r);setError('');}
      }catch(e){if(active)setError(e instanceof Error?e.message:'Unable to load invoice.');}
      finally{inFlight=false;}
    };
    void read();const timer=setInterval(()=>void read(),5000);
    return ()=>{active=false;clearInterval(timer);};
  },[requestId,revision]);
  return <>
    <section className="card payment-screen"><span className="eyebrow">STELLAR TESTNET · INVOICE PAYMENT</span><h1>Pay an invoice</h1>
      <p role="alert" className="error">{error}</p>
      {!invoice&&!error&&<p role="status">Loading payment request…</p>}
      {error&&<button onClick={()=>setRevision(x=>x+1)}>Reload invoice</button>}
      {invoice&&<><h2>{invoice.merchantName}</h2><dl><dt>Invoice</dt><dd>{invoice.invoiceReference}</dd><dt>Invoice total</dt><dd>{xlm(invoice.amountStroops)} Testnet XLM</dd><dt>Received and allocated</dt><dd>{xlm(invoice.paidStroops)} XLM</dd><dt>Remaining</dt><dd>{xlm(invoice.remainingStroops)} XLM</dd><dt>Receiving wallet</dt><dd className="mono">{invoice.destination}</dd><dt>Expires</dt><dd>{new Date(invoice.expiresAt).toLocaleString()}</dd></dl>
        <p role="status">{invoice.status.replaceAll('_',' ')}{invoice.expired?' · Payment link expired':''}{invoice.paymentPending?' · A payment is being resolved':''}</p>
        {invoice.status!=='unpaid'&&<p role="status">Invoice already paid or allocated. This unique invoice QR has been used and no further checkout payment is permitted.</p>}
        {invoice.paymentPending&&<p role="status">A payment is awaiting resolution. Other payers cannot start a replacement; check the existing payment instead.</p>}
        <p>The merchant name is supplied by the wallet owner. Confirm the merchant and invoice before approving. Testnet XLM has no real-world value.</p>
        {!adapter&&invoice.status==='unpaid'&&!invoice.expired&&!invoice.paymentPending&&<p>Sign in above with your email and passkey to pay this invoice. The invoice will remain open here.</p>}
      </>}
    </section>
    {invoice&&adapter&&<Send request={invoice} checkoutUnavailable={!!error}/>}
  </>;
}
