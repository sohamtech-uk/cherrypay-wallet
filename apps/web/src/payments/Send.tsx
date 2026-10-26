import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Mail, Wallet } from 'lucide-react';
import { usePayments } from './context';
import { checkQuote, destinationError, explorerLink, NETWORK, paymentBreakdown, statusLabel, stroops, xlm, type Attempt, type Quote, type Invoice, type ResolvedRecipient } from './model';

export function Send({request,checkoutUnavailable=false}:{request?:Invoice;checkoutUnavailable?:boolean}={}) {
  const adapter = usePayments();
  // Remount for each authenticated wallet; locks are public identifiers, never credentials.
  return adapter?.network === NETWORK && adapter.canSign !== false ? <SendForm key={`${adapter.address}:${request?.id??'send'}`} request={request} checkoutUnavailable={checkoutUnavailable}/> : <section className="card payment-screen"><h1>Send XLM</h1><h2>Signing service not connected</h2><p>Connect your passkey wallet and verified Testnet payment service to preview fees and approve transfers. Watch-only accounts cannot send.</p><Link className="secondary-button" to="/onboarding">Set up wallet</Link></section>;
}
function SendForm({request,checkoutUnavailable}:{request?:Invoice;checkoutUnavailable:boolean}) {
  const adapter = usePayments()!;
  const [params] = useSearchParams();
  const storageKey = `cherrypay:pending:${NETWORK}:${adapter.address}`;
  const [key, setKey] = useState(() => { try { return localStorage.getItem(storageKey) ?? ''; } catch { return 'storage-unavailable'; } });
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === storageKey) setKey(event.newValue ?? ''); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [storageKey]);
  const [destination, setDestination] = useState(request?.destination ?? params.get('to') ?? '');
  const [amount, setAmount] = useState(request?xlm(request.remainingStroops):'');
  const [detailsStep, setDetailsStep] = useState<'method'|'recipient'>(request || params.get('to') ? 'recipient' : 'method');
  const [recipientMode, setRecipientMode] = useState<'address'|'email'|undefined>(request || params.get('to') ? 'address' : undefined);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [resolvedRecipient, setResolvedRecipient] = useState<ResolvedRecipient>();
  const [quote, setQuote] = useState<Quote>();
  const [attempt, setAttempt] = useState<Attempt>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mutex = useRef(false);
  const alert = useRef<HTMLParagraphElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const statusHeading = useRef<HTMLHeadingElement>(null);
  const methodHeading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(detailsStep);
  const previousKey = useRef(key);
  const destinationInput = useRef<HTMLInputElement>(null);
  const recipientEmailInput = useRef<HTMLInputElement>(null);
  const previousQuote = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (error) alert.current?.focus();
    else if (quote && previousQuote.current !== quote.id) reviewHeading.current?.focus();
    else if (!quote && previousQuote.current)
      (key ? statusHeading.current : detailsStep === 'method' ? methodHeading.current : recipientMode === 'email' ? recipientEmailInput.current : destinationInput.current)?.focus();
    else if (previousStep.current !== detailsStep || (previousKey.current && !key))
      (detailsStep === 'method' ? methodHeading.current : recipientMode === 'email' ? recipientEmailInput.current : destinationInput.current)?.focus();
    previousQuote.current = quote?.id;
    previousStep.current = detailsStep;
    previousKey.current = key;
  }, [quote, key, error, recipientMode, detailsStep]);
  const [accepted, setAccepted] = useState(false);
  useEffect(()=>{if(request&&!quote&&!key){setDestination(request.destination);setAmount(xlm(request.remainingStroops));}},[request,quote,key]);
  // Historical partially-paid invoices are permanently closed to another checkout.
  const requestClosed=!!request&&(request.status!=='unpaid'||request.paidStroops!=='0'||request.expired||request.expiresAt<=Date.now()||request.remainingStroops==='0'||checkoutUnavailable);
  const destinationFeedback = recipientMode === 'address' && destination ? destinationError(destination.trim(), adapter.supportedDestinations) : '';
  const intent = (resolvedAddress?: string) => {
    const recipient = (resolvedAddress ?? destination).trim();
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
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'The wallet service is unavailable. Try checking status again.'); }
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
  function resetDetails() {
    setDetailsStep(request ? 'recipient' : 'method');
    setRecipientMode(request ? 'address' : undefined);
    setDestination(request?.destination ?? '');
    setAmount(request ? xlm(request.remainingStroops) : '');
    setRecipientEmail(''); setResolvedRecipient(undefined); setAccepted(false);
  }
  const terminal = attempt && (attempt.status === 'failed' || attempt.status === 'rejected' || (attempt.status === 'confirmed' && attempt.verified));
  return <section className="card payment-screen send-screen"><span className="eyebrow">WALLET PAYMENT</span><h1>Send XLM</h1>
    <p>Choose a recipient and amount. Review the fee before approving.</p><ol className="payment-steps" aria-label="Payment progress"><li aria-current={!quote && !key ? 'step' : undefined}>1 · Details</li><li aria-current={quote ? 'step' : undefined}>2 · Review</li><li aria-current={key && !quote ? 'step' : undefined}>3 · Status</li></ol>
    {request&&<p>Invoice: <strong>{request.invoiceReference}</strong> · {request.merchantName}. <Link to="/send">Manage another saved payment</Link></p>}
    {quote?.paymentRequestId&&!request&&<p>Linked invoice: <Link to={`/pay/${quote.paymentRequestId}`}>View invoice checkout</Link></p>}
    <p ref={alert} tabIndex={-1} role="alert" className="error">{error}</p>
    {!key && !quote && detailsStep === 'method' && <section className="payment-method-picker" aria-labelledby="payment-method-heading">
      <h2 id="payment-method-heading" ref={methodHeading} tabIndex={-1}>How do you want to pay?</h2>
      <p>Choose how to find your recipient. You’ll enter the amount next.</p>
      <div className="payment-method-grid">
        {(['address', 'email'] as const).map(method => <button key={method} type="button"
          className="secondary-button payment-method-card" aria-label={`Pay by ${method}`} aria-describedby={`pay-by-${method}-help`}
          aria-pressed={recipientMode === method} disabled={busy || (method === 'email' && !adapter.resolveRecipientEmail)}
          onClick={() => { if (recipientMode !== method) { setDestination(''); setRecipientEmail(''); setResolvedRecipient(undefined); } setRecipientMode(method); setError(''); }}>
          {method === 'address' ? <Wallet size={24} aria-hidden="true"/> : <Mail size={24} aria-hidden="true"/>}
          <strong>Pay by {method}</strong>
          <span id={`pay-by-${method}-help`}>{method === 'address' ? 'Use a Stellar wallet address.' : adapter.resolveRecipientEmail ? 'Use a verified email that accepts payments.' : 'Email payments are unavailable for this connection.'}</span>
          {recipientMode === method && <span className="payment-method-selected"><CheckCircle2 size={16} aria-hidden="true"/> Selected</span>}
        </button>)}
      </div>
      <button className="payment-method-next" type="button" disabled={!recipientMode || busy}
        onClick={() => setDetailsStep('recipient')}>Next</button>
    </section>}
    {!key && detailsStep === 'recipient' && <form onSubmit={e => { e.preventDefault(); void run(async () => { let recipientAddress: string | undefined;
      if (recipientMode === 'email' && !request) {
        if (!adapter.resolveRecipientEmail) throw Error('Email recipient lookup is unavailable.');
        const match = await adapter.resolveRecipientEmail(recipientEmail);
        recipientAddress = match.address;
        setDestination(match.address); setResolvedRecipient(match);
      }
      const requested = intent(recipientAddress); let previewKey: string | undefined;
      if (adapter.persistentPreview) {
        if (localStorage.getItem(storageKey)) throw new Error('Check the existing payment before creating another.');
        previewKey = crypto.randomUUID(); localStorage.setItem(storageKey, previewKey); setKey(previewKey);
      }
      const preview = await adapter.prepare(requested, previewKey); checkQuote(preview, requested); setQuote(preview); setAccepted(false); }); }}>
      <fieldset disabled={busy || !!quote || requestClosed}><legend>Payment details</legend>
        {!request && <div className="payment-method-summary"><h2>Pay by {recipientMode}</h2>
          {!quote && <button type="button" className="secondary-button" onClick={() => { setError(''); setDetailsStep('method'); }}>Change payment method</button>}
        </div>}
        {recipientMode === 'email' && !request ? <>
          <label htmlFor="recipient-email">Recipient email</label>
          <input ref={recipientEmailInput} id="recipient-email" type="email" autoComplete="off" maxLength={254} required value={recipientEmail} onChange={e => { setRecipientEmail(e.target.value); setResolvedRecipient(undefined); }} aria-describedby="recipient-email-help"/>
          <p id="recipient-email-help">Only verified, opted-in Cherry Wallet accounts with an active Testnet smart wallet can receive payments by email. This does not verify a legal name or company.</p>
        </> : <>
          <label htmlFor="destination">Recipient address</label>
          <input ref={destinationInput} id="destination" readOnly={!!request} autoComplete="off" spellCheck={false} value={destination} onChange={e => { setDestination(e.target.value); setResolvedRecipient(undefined); }} aria-invalid={!!destinationFeedback} aria-describedby="destination-feedback" required/>
          <p id="destination-feedback">{destinationFeedback || 'Use a Stellar Testnet G- or C-address. Memo-required exchange deposits are not supported.'}</p>
        </>}
        <label htmlFor="amount">Exact amount (XLM)</label><input id="amount" readOnly={!!request} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} aria-describedby="amount-help" required/>
        <p id="amount-help">XLM only · up to 7 decimal places.</p>
      </fieldset>
      {!quote && <button disabled={busy || requestClosed || !!request?.paymentPending} type="submit">{busy ? 'Loading fee preview…' : 'Review payment'}</button>}
    </form>}
    {quote && (!key || adapter.persistentPreview) && <section aria-label="Review payment"><h2 ref={reviewHeading} tabIndex={-1}>Review and approve</h2><dl><dt>Network</dt><dd>Stellar Testnet</dd><dt>From</dt><dd>{quote.from}</dd>
      {resolvedRecipient && <><dt>Recipient email</dt><dd>{resolvedRecipient.email} · mailbox verified and wallet bound (not legal identity verified)</dd></>}
      <dt>Recipient wallet (actual destination)</dt><dd>{quote.destination}</dd>
      <dt>Recipient receives</dt><dd>{xlm(quote.amountStroops)} XLM</dd>
      <dt>Cherry Wallet platform fee</dt><dd>{xlm(paymentBreakdown(quote).serviceFeeStroops)} XLM (none charged)</dd>
      <dt>Maximum Stellar network fee allowance</dt><dd>{xlm(paymentBreakdown(quote).maximumNetworkFeeStroops)} XLM · {quote.feePayer === 'sponsor' ? 'sponsor pays, up to this limit' : 'wallet pays, up to this limit'}</dd>
      <dt>Your maximum network fee contribution</dt><dd>{xlm(paymentBreakdown(quote).walletNetworkFeeLimitStroops)} XLM</dd>
      <dt>Maximum total debit from your wallet</dt><dd>{xlm(paymentBreakdown(quote).maximumWalletDebitStroops)} XLM</dd>
      <dt>FX, PAYE, NI and pension deductions</dt><dd>Not calculated or charged by this Testnet XLM wallet</dd>
      <dt>Preview expires</dt><dd>{new Date(quote.expiresAt).toLocaleString()}</dd></dl>
      <label className="check-label"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} disabled={busy}/> I have checked the recipient, amount, fee and Testnet network.</label>
      <div className="actions"><button disabled={!accepted || busy || requestClosed} onClick={() => void run(async () => {
        checkQuote(quote, intent(quote.destination));
        if (recipientMode === 'email' && !request) {
          if (!resolvedRecipient || resolvedRecipient.address !== quote.destination || !adapter.resolveRecipientEmail)
            throw Error('Recipient email verification was lost. Edit and resolve it again.');
          const latest = await adapter.resolveRecipientEmail(recipientEmail);
          if (latest.email !== resolvedRecipient.email || latest.address !== quote.destination)
            throw Error('Recipient wallet changed. Do not approve; cancel the saved preview and start again.');
        }
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
    {key && <section aria-label="Payment status"><h2 ref={statusHeading} tabIndex={-1}>Payment status</h2><p role="status">{busy ? 'Waiting for wallet service or approval…' : attempt ? statusLabel(attempt) : 'Outcome unknown — recover the existing attempt before starting another payment.'}</p>
      {attempt && <><p>{attempt.failureMessage}</p><p className="mono">Attempt: {attempt.id}</p><Link className="secondary-button" to={`/history/${encodeURIComponent(attempt.id)}`}>View payment detail</Link>{explorerLink(attempt) && <a className="secondary-button" href={explorerLink(attempt)} target="_blank" rel="noreferrer">Verified Testnet receipt</a>}</>}
      <p>{polling ? 'Status refreshes automatically every 5 seconds while confirmation is unresolved. ' : ''}Checking status never creates or resubmits a replacement payment. If approval was interrupted, review the existing attempt with your wallet service.</p>
      <div className="actions"><button disabled={busy || key === 'storage-unavailable'} onClick={() => void run(async () => { const result = await adapter.getAttemptByKey(key); if (!result) throw new Error('The attempt is not yet available. Check again later; do not submit a replacement.'); setAttempt(validateAttempt(result)); })}>Check existing attempt</button>
      {!terminal && key !== 'storage-unavailable' && adapter.resetAttempt && <button className="secondary-button" disabled={busy} onClick={()=>void run(async()=>{
        await adapter.resetAttempt!(key);
        if(localStorage.getItem(storageKey)!==key)throw Error('The saved payment changed in another tab. Check its status before resetting.');
        localStorage.removeItem(storageKey);setKey('');setAttempt(undefined);setQuote(undefined);resetDetails();
      })}>Reset and change recipient</button>}
      {attempt?.status === 'awaiting_approval' && adapter.getQuote && <button disabled={busy} onClick={() => void run(async () => { const recovered = await adapter.getQuote!(attempt.id); setDetailsStep('recipient'); setRecipientMode(mode => mode ?? 'address'); setDestination(recovered.destination); setAmount(xlm(recovered.amountStroops)); setQuote(recovered); setAccepted(false); })}>Review existing payment</button>}
      {attempt?.status === 'awaiting_approval' && adapter.cancelAttempt && <button disabled={busy} onClick={() => void run(async () => { setAttempt(validateAttempt(await adapter.cancelAttempt!(attempt.id))); setQuote(undefined); })}>Cancel unsigned payment</button>}
      {terminal && <button className="secondary-button" disabled={busy} onClick={() => { try { localStorage.removeItem(storageKey); setKey(''); setAttempt(undefined); setQuote(undefined); resetDetails(); setError(''); } catch { setError('Unable to clear recovery record. Enable browser storage and reload.'); } }}>Start a new payment</button>}</div>
    </section>}
  </section>;
}

