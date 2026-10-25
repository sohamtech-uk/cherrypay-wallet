import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePayments } from './context';
import { checkQuote, destinationError, explorerLink, NETWORK, statusLabel, stroops, xlm, type Attempt, type Quote } from './model';

export function Send() {
  const adapter = usePayments();
  // Remount for each authenticated wallet; locks are public identifiers, never credentials.
  return adapter?.network === NETWORK && adapter.canSign !== false ? <SendForm key={adapter.address} /> : <section className="card payment-screen"><h1>Send XLM</h1><h2>Signing service not connected</h2><p>Connect your passkey wallet and verified Testnet payment service to preview fees and approve transfers. Watch-only accounts cannot send.</p><Link className="secondary-button" to="/onboarding">Set up wallet</Link></section>;
}
function SendForm() {
  const adapter = usePayments()!;
  const storageKey = `cherrypay:pending:${NETWORK}:${adapter.address}`;
  const [key, setKey] = useState(() => { try { return localStorage.getItem(storageKey) ?? ''; } catch { return 'storage-unavailable'; } });
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === storageKey) setKey(event.newValue ?? ''); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [storageKey]);
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote>();
  const [attempt, setAttempt] = useState<Attempt>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const mutex = useRef(false);
  const alert = useRef<HTMLParagraphElement>(null);
  const [accepted, setAccepted] = useState(false);
  const destinationFeedback = destination ? destinationError(destination.trim(), adapter.supportedDestinations) : '';
  const intent = () => {
    const recipient = destination.trim();
    const invalid = destinationError(recipient, adapter.supportedDestinations);
    if (invalid) throw new Error(invalid);
    const exact = stroops(amount);
    if (exact <= 0n) throw new Error('Enter an amount greater than zero.');
    return { network: NETWORK, from: adapter.address, destination: recipient, amountStroops: exact.toString() };
  };
  async function run(action: () => Promise<void>) {
    if (mutex.current) return;
    mutex.current = true; setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'The wallet service is unavailable. Try checking status again.'); setTimeout(() => alert.current?.focus(), 0); }
    finally { mutex.current = false; setBusy(false); }
  }
  function validateAttempt(value: Attempt) {
    if (value.network !== NETWORK || value.from !== adapter.address) throw new Error('Wallet service returned an attempt for a different wallet or network.');
    return value;
  }
  const terminal = attempt && (attempt.status === 'failed' || attempt.status === 'rejected' || (attempt.status === 'confirmed' && attempt.verified));
  return <section className="card payment-screen"><span className="eyebrow">STELLAR TESTNET</span><h1>Send XLM</h1>
    <p>Review the exact destination, amount and fee before approving with your wallet.</p>
    <p ref={alert} tabIndex={-1} role="alert" className="error">{error}</p>
    {!key && <form onSubmit={e => { e.preventDefault(); void run(async () => { const requested = intent(); let previewKey: string | undefined;
      if (adapter.persistentPreview) {
        if (localStorage.getItem(storageKey)) throw new Error('Check the existing payment before creating another.');
        previewKey = crypto.randomUUID(); localStorage.setItem(storageKey, previewKey); setKey(previewKey);
      }
      const preview = await adapter.prepare(requested, previewKey); checkQuote(preview, requested); setQuote(preview); setAccepted(false); }); }}>
      <fieldset disabled={busy || !!quote}><legend>Payment details</legend>
        <label htmlFor="destination">Recipient address</label><input id="destination" autoComplete="off" spellCheck={false} value={destination} onChange={e => setDestination(e.target.value)} aria-invalid={!!destinationFeedback} aria-describedby="destination-feedback" required/>
        <p id="destination-feedback">{destinationFeedback || 'Only backend-enabled Testnet destinations are accepted. Memo-required exchange deposits are not supported.'}</p>
        <label htmlFor="amount">Exact amount (XLM)</label><input id="amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} aria-describedby="amount-help" required/>
        <p id="amount-help">Up to 7 decimal places. No rounding or currency conversion.</p>
      </fieldset>
      {!quote && <button disabled={busy} type="submit">{busy ? 'Loading fee preview…' : 'Preview payment'}</button>}
    </form>}
    {quote && (!key || adapter.persistentPreview) && <section aria-label="Review payment"><h2>Review and approve</h2><dl><dt>Network</dt><dd>Stellar Testnet</dd><dt>From</dt><dd>{quote.from}</dd><dt>Recipient</dt><dd>{quote.destination}</dd><dt>Amount</dt><dd>{xlm(quote.amountStroops)} XLM</dd><dt>Network fee</dt><dd>{xlm(quote.feeStroops)} XLM · {quote.feePayer === 'sponsor' ? 'paid by sponsor' : 'paid by your wallet'}</dd><dt>Total from wallet</dt><dd>{xlm((BigInt(quote.amountStroops) + (quote.feePayer === 'wallet' ? BigInt(quote.feeStroops) : 0n)).toString())} XLM</dd><dt>Preview expires</dt><dd>{new Date(quote.expiresAt).toLocaleString()}</dd></dl>
      <label className="check-label"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)} disabled={busy}/> I have checked the recipient, amount, fee and Testnet network.</label>
      <div className="actions"><button disabled={!accepted || busy} onClick={() => void run(async () => {
        checkQuote(quote, intent());
        const existing = localStorage.getItem(storageKey);
        if (existing && (!adapter.persistentPreview || existing !== key)) { setKey(existing); throw new Error('An existing payment needs a status check before another can be created.'); }
        const idempotencyKey = adapter.persistentPreview ? key : crypto.randomUUID();
        // Fail closed if durable recovery cannot be established before a network call.
        localStorage.setItem(storageKey, idempotencyKey); setKey(idempotencyKey);
        const created = validateAttempt(await adapter.createAttempt(quote, idempotencyKey));
        setAttempt(created);
        if (created.destination !== quote.destination || created.amountStroops !== quote.amountStroops || created.feeStroops !== quote.feeStroops) throw new Error('Attempt differs from the reviewed payment. Do not approve; check status.');
        setQuote(undefined);
        if (created.status === 'awaiting_approval') setAttempt(validateAttempt(await adapter.approve(created.id, quote))); setQuote(undefined);
      })}>{busy ? 'Requesting approval…' : 'Approve exact payment'}</button><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { if (adapter.persistentPreview) { if (!adapter.cancelAttempt) throw new Error('Cancellation unavailable.'); const cancelled = validateAttempt(await adapter.cancelAttempt(quote.id)); setAttempt(cancelled); if (cancelled.status !== 'rejected' && cancelled.status !== 'failed') throw new Error('Check the existing payment before editing.'); localStorage.removeItem(storageKey); setKey(''); setAttempt(undefined); } setQuote(undefined); setAccepted(false); })}>Edit payment</button></div>
    </section>}
    {key && <section aria-label="Payment status"><h2>Payment status</h2><p role="status">{busy ? 'Waiting for wallet service or approval…' : attempt ? statusLabel(attempt) : 'Outcome unknown — recover the existing attempt before starting another payment.'}</p>
      {attempt && <><p>{attempt.failureMessage}</p><p className="mono">Attempt: {attempt.id}</p><Link className="secondary-button" to={`/history/${encodeURIComponent(attempt.id)}`}>View payment detail</Link>{explorerLink(attempt) && <a className="secondary-button" href={explorerLink(attempt)} target="_blank" rel="noreferrer">Verified Testnet receipt</a>}</>}
      <p>Checking status never resubmits a payment. If approval was interrupted, review the existing attempt with your wallet service.</p>
      <div className="actions"><button disabled={busy || key === 'storage-unavailable'} onClick={() => void run(async () => { const result = await adapter.getAttemptByKey(key); if (!result) throw new Error('The attempt is not yet available. Check again later; do not submit a replacement.'); setAttempt(validateAttempt(result)); })}>Check existing attempt</button>
      {attempt?.status === 'awaiting_approval' && adapter.getQuote && <button disabled={busy} onClick={() => void run(async () => { const recovered = await adapter.getQuote!(attempt.id); setDestination(recovered.destination); setAmount(xlm(recovered.amountStroops)); setQuote(recovered); setAccepted(false); })}>Review existing payment</button>}
      {attempt?.status === 'awaiting_approval' && adapter.cancelAttempt && <button disabled={busy} onClick={() => void run(async () => { setAttempt(validateAttempt(await adapter.cancelAttempt!(attempt.id))); setQuote(undefined); })}>Cancel unsigned payment</button>}
      {terminal && <button className="secondary-button" disabled={busy} onClick={() => { try { localStorage.removeItem(storageKey); setKey(''); setAttempt(undefined); setQuote(undefined); setAccepted(false); setAmount(''); setError(''); } catch { setError('Unable to clear recovery record. Enable browser storage and reload.'); } }}>Start a new payment</button>}</div>
    </section>}
  </section>;
}

