import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePayments } from './context';
import { checkQuote, destinationError, explorerLink, NETWORK, statusLabel, stroops, xlm, type Attempt, type Quote, type Invoice } from './model';

export function Send({request,checkoutUnavailable=false}:{request?:Invoice;checkoutUnavailable?:boolean}={}) {
  const adapter = usePayments();
  // Remount for each authenticated wallet; locks are public identifiers, never credentials.
  return adapter?.network === NETWORK && adapter.canSign !== false ? <SendForm key={`${adapter.address}:${request?.id??'send'}`} request={request} checkoutUnavailable={checkoutUnavailable}/> : <section className="card payment-screen"><h1>Send XLM</h1><h2>Signing service not connected</h2><p>Connect your passkey wallet and verified Testnet payment service to preview fees and approve transfers. Watch-only accounts cannot send.</p><Link className="secondary-button" to="/onboarding">Set up wallet</Link></section>;
}
function SendForm({request,checkoutUnavailable}:{request?:Invoice;checkoutUnavailable:boolean}) {
  const adapter = usePayments()!;
  const storageKey = `cherrypay:pending:${NETWORK}:${adapter.address}`;
  const [key, setKey] = useState(() => { try { return localStorage.getItem(storageKey) ?? ''; } catch { return 'storage-unavailable'; } });
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === storageKey) setKey(event.newValue ?? ''); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [storageKey]);
  const [destination, setDestination] = useState(request?.destination??'');
  const [amount, setAmount] = useState(request?xlm(request.remainingStroops):'');
  const [quote, setQuote] = useState<Quote>();
  const [attempt, setAttempt] = useState<Attempt>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mutex = useRef(false);
  const alert = useRef<HTMLParagraphElement>(null);
  const [accepted, setAccepted] = useState(false);
  useEffect(()=>{if(request&&!quote&&!key){setDestination(request.destination);setAmount(xlm(request.remainingStroops));}},[request,quote,key]);
  const requestClosed=!!request&&(request.expired||request.expiresAt<=Date.now()||request.remainingStroops==='0'||checkoutUnavailable);
  const destinationFeedback = destination ? destinationError(destination.trim(), adapter.supportedDestinations) : '';
  const intent = () => {
    const recipient = destination.trim();
    const invalid = destinationError(recipient, adapter.supportedDestinations);
    if (invalid) throw new Error(invalid);
    const exact = stroops(amount);
    if (exact <= 0n) throw new Error('Enter an amount greater than zero.');
    if(requestClosed)throw Error('This invoice is paid, expired, or cannot currently be verified. Check the existing payment status.');
    if(request&&(recipient!==request.destination||exact.toString()!==request.remainingStroops))throw Error('Invoice amount changed. Refresh and review the remaining balance.');
    const paymentRequestId=request?.id??quote?.paymentRequestId;
    return { network: NETWORK, from: adapter.address, destination: recipient, amountStroops: exact.toString(),...(paymentRequestId?{paymentRequestId}:{}) };
  };
  async function run(action: () => Promise<void>) {
    if (mutex.current) return;
    mutex.current = true; setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'The wallet service is unavailable. Try checking status again.'); setTimeout(() => alert.current?.focus(), 0); }
    finally { mutex.current = false; setBusy(false); }
  }
  const requestId=request?.id;
  const validateAttempt=useCallback((value: Attempt) => {
    if (value.network !== NETWORK || value.from !== adapter.address) throw new Error('Wallet service returned an attempt for a different wallet or network.');
    if(requestId&&value.paymentRequestId!==requestId)throw Error('A different payment is saved. Open Send to resolve it before paying this invoice.');
    return value;
  },[adapter.address,requestId]);
  const polling = !!key && key !== 'storage-unavailable' && (!attempt || ['submitted','pending','unknown'].includes(attempt.status));
  useEffect(() => {
    if (!polling) return;
    let active = true, inFlight = false;
    const poll = async () => {
      if (inFlight || mutex.current) return;
      inFlight = true;
      try {
        const result = await adapter.getAttemptByKey(key);
        if (active && result) { setAttempt(validateAttempt(result)); setError(''); }
      } catch {
        // Keep the last durable status visible; the next interval retries the read.
      } finally { inFlight = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [adapter, key, polling, validateAttempt]);
  const terminal = attempt && (attempt.status === 'failed' || attempt.status === 'rejected' || (attempt.status === 'confirmed' && attempt.verified));
  return <section className="card payment-screen"><span className="eyebrow">STELLAR TESTNET</span><h1>Send XLM</h1>
    <p>Review the exact destination, amount and fee before approving with your wallet.</p>
    {request&&<p>Invoice: <strong>{request.invoiceReference}</strong> · {request.merchantName}. <Link to="/send">Manage another saved payment</Link></p>}
    {quote?.paymentRequestId&&!request&&<p>Linked invoice: <Link to={`/pay/${quote.paymentRequestId}`}>View invoice checkout</Link></p>}
    <p ref={alert} tabIndex={-1} role="alert" className="error">{error}</p>
    {!key && <form onSubmit={e => { e.preventDefault(); void run(async () => { const requested = intent(); let previewKey: string | undefined;
      if (adapter.persistentPreview) {
        if (localStorage.getItem(storageKey)) throw new Error('Check the existing payment before creating another.');
        previewKey = crypto.randomUUID(); localStorage.setItem(storageKey, previewKey); setKey(previewKey);
      }
      const preview = await adapter.prepare(requested, previewKey); checkQuote(preview, requested); setQuote(preview); setAccepted(false); }); }}>
      <fieldset disabled={busy || !!quote || requestClosed}><legend>Payment details</legend>
        <label htmlFor="destination">Recipient address</label><input id="destination" readOnly={!!request} autoComplete="off" spellCheck={false} value={destination} onChange={e => setDestination(e.target.value)} aria-invalid={!!destinationFeedback} aria-describedby="destination-feedback" required/>
        <p id="destination-feedback">{destinationFeedback || 'Only backend-enabled Testnet destinations are accepted. Memo-required exchange deposits are not supported.'}</p>
        <label htmlFor="amount">Exact amount (XLM)</label><input id="amount" readOnly={!!request} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} aria-describedby="amount-help" required/>
        <p id="amount-help">Up to 7 decimal places. No rounding or currency conversion.</p>
      </fieldset>
      {!quote && <button disabled={busy || requestClosed || !!request?.paymentPending} type="submit">{busy ? 'Loading fee preview…' : 'Preview payment'}</button>}
    </form>}
    {quote && (!key || adapter.persistentPreview) && <section aria-label="Review payment"><h2>Review and approve</h2><dl><dt>Network</dt><dd>Stellar Testnet</dd><dt>From</dt><dd>{quote.from}</dd><dt>Recipient</dt><dd>{quote.destination}</dd><dt>Amount</dt><dd>{xlm(quote.amountStroops)} XLM</dd><dt>Maximum network fee</dt><dd>{xlm(quote.feeStroops)} XLM · {quote.feePayer === 'sponsor' ? 'paid by sponsor' : 'paid by your wallet'}</dd><dt>Total from wallet</dt><dd>{xlm((BigInt(quote.amountStroops) + (quote.feePayer === 'wallet' ? BigInt(quote.feeStroops) : 0n)).toString())} XLM</dd><dt>Preview expires</dt><dd>{new Date(quote.expiresAt).toLocaleString()}</dd></dl>
      <label className="check-label"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} disabled={busy}/> I have checked the recipient, amount, fee and Testnet network.</label>
      <div className="actions"><button disabled={!accepted || busy || requestClosed} onClick={() => void run(async () => {
        checkQuote(quote, intent());
        const existing = localStorage.getItem(storageKey);
        if (existing && (!adapter.persistentPreview || existing !== key)) { setKey(existing); throw new Error('An existing payment needs a status check before another can be created.'); }
        const idempotencyKey = adapter.persistentPreview ? key : crypto.randomUUID();
        // Fail closed if durable recovery cannot be established before a network call.
        localStorage.setItem(storageKey, idempotencyKey); setKey(idempotencyKey);
        const created = validateAttempt(await adapter.createAttempt(quote, idempotencyKey));
        setAttempt(created);
        if (created.destination !== quote.destination || created.amountStroops !== quote.amountStroops || created.feeStroops !== quote.feeStroops || created.paymentRequestId!==quote.paymentRequestId) throw new Error('Attempt differs from the reviewed payment. Do not approve; check status.');
        setQuote(undefined);
        if (created.status === 'awaiting_approval') setAttempt(validateAttempt(await adapter.approve(created.id, quote))); setQuote(undefined);
      })}>{busy ? 'Requesting approval…' : 'Approve exact payment'}</button><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { if (adapter.persistentPreview) { if (!adapter.cancelAttempt) throw new Error('Cancellation unavailable.'); const cancelled = validateAttempt(await adapter.cancelAttempt(quote.id)); setAttempt(cancelled); if (cancelled.status !== 'rejected' && cancelled.status !== 'failed') throw new Error('Check the existing payment before editing.'); localStorage.removeItem(storageKey); setKey(''); setAttempt(undefined); } setQuote(undefined); setAccepted(false); })}>Edit payment</button></div>
    </section>}
    {key && <section aria-label="Payment status"><h2>Payment status</h2><p role="status">{busy ? 'Waiting for wallet service or approval…' : attempt ? statusLabel(attempt) : 'Outcome unknown — recover the existing attempt before starting another payment.'}</p>
      {attempt && <><p>{attempt.failureMessage}</p><p className="mono">Attempt: {attempt.id}</p><Link className="secondary-button" to={`/history/${encodeURIComponent(attempt.id)}`}>View payment detail</Link>{explorerLink(attempt) && <a className="secondary-button" href={explorerLink(attempt)} target="_blank" rel="noreferrer">Verified Testnet receipt</a>}</>}
      <p>{polling ? 'Status refreshes automatically every 5 seconds while confirmation is unresolved. ' : ''}Checking status never creates or resubmits a replacement payment. If approval was interrupted, review the existing attempt with your wallet service.</p>
      <div className="actions"><button disabled={busy || key === 'storage-unavailable'} onClick={() => void run(async () => { const result = await adapter.getAttemptByKey(key); if (!result) throw new Error('The attempt is not yet available. Check again later; do not submit a replacement.'); setAttempt(validateAttempt(result)); })}>Check existing attempt</button>
      {!terminal && key !== 'storage-unavailable' && adapter.resetAttempt && <button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{
        await adapter.resetAttempt!(key);
        if(localStorage.getItem(storageKey)!==key)throw Error('The saved payment changed in another tab. Check its status before resetting.');
        localStorage.removeItem(storageKey);setKey('');setAttempt(undefined);setQuote(undefined);setDestination('');setAmount('');setAccepted(false);
      })}>Reset and change recipient</button>}
      {attempt?.status === 'awaiting_approval' && adapter.getQuote && <button disabled={busy} onClick={() => void run(async () => { const recovered = await adapter.getQuote!(attempt.id); setDestination(recovered.destination); setAmount(xlm(recovered.amountStroops)); setQuote(recovered); setAccepted(false); })}>Review existing payment</button>}
      {attempt?.status === 'awaiting_approval' && adapter.cancelAttempt && <button disabled={busy} onClick={() => void run(async () => { setAttempt(validateAttempt(await adapter.cancelAttempt!(attempt.id))); setQuote(undefined); })}>Cancel unsigned payment</button>}
      {terminal && <button className="secondary-button" disabled={busy} onClick={() => { try { localStorage.removeItem(storageKey); setKey(''); setAttempt(undefined); setQuote(undefined); setAccepted(false); setAmount(''); setError(''); } catch { setError('Unable to clear recovery record. Enable browser storage and reload.'); } }}>Start a new payment</button>}</div>
    </section>}
  </section>;
}

