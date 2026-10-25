import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { assertFresh, auroraClient, BASE_USDC_CONTRACT, decodeQuote, evmAddress, RECOVERY_KEY, sameQuote, units, validateInput, type AuroraQuote, type Capabilities, type SwapStatus } from './client';

type Record = { version: 1; quote: AuroraQuote; reviewed: boolean };
function readRecord(): Record | null {
  const saved = localStorage.getItem(RECOVERY_KEY);
  if (!saved) return null;
  const value = JSON.parse(saved) as Record;
  if (value.version !== 1) throw Error('Unsupported saved swap. Keep the existing deposit address and contact support.');
  return { version: 1, quote: decodeQuote(value.quote), reviewed: value.reviewed === true };
}
const labels: RecordStatusLabels = {
  PENDING_DEPOSIT: 'Awaiting deposit', INCOMPLETE_DEPOSIT: 'Incomplete deposit — do not send a top-up', PROCESSING: 'Processing — do not fund again',
  SUCCESS: 'Aurora reports completion', REFUNDED: 'Aurora reports a refund', FAILED: 'Aurora reports a failure — inspect before retrying', UNKNOWN: 'Outcome unknown — do not fund again',
};
type RecordStatusLabels = { [K in SwapStatus['status']]: string };

export function AuroraPayment() {
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [configError, setConfigError] = useState('');
  const [configNonce, setConfigNonce] = useState(0);
  const [recipient, setRecipient] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<AuroraQuote>();
  const [record, setRecord] = useState<Record | null>(null);
  const [storageError, setStorageError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<SwapStatus>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recoveryAddress, setRecoveryAddress] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [pollNonce, setPollNonce] = useState(0);
  const [pollStopped, setPollStopped] = useState(false);
  const mutex = useRef(false);
  const mounted = useRef(true);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); setConfigError('');
    void auroraClient.capabilities(controller.signal).then(v => { if (!controller.signal.aborted) setCapabilities(v); }).catch(() => { if (!controller.signal.aborted) setConfigError('Unable to check Aurora availability.'); });
    return () => controller.abort();
  }, [configNonce]);
  useEffect(() => {
    const sync = () => {
      try { setRecord(readRecord()); setStorageError(''); }
      catch { setStorageError('Saved-swap storage is unavailable or damaged. Funding is blocked. Recover status using the original Base deposit address.'); }
      setQuote(undefined); setAccepted(false); setStatus(undefined);
    };
    sync();
    const listener = (e: StorageEvent) => { if (e.key === RECOVERY_KEY || e.key === null) sync(); };
    window.addEventListener('storage', listener);
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => { window.removeEventListener('storage', listener); clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!record || !capabilities?.statusAvailable) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined, reads = 0;
    setPollStopped(false);
    async function poll() {
      try {
        const next = await auroraClient.status(record!.quote.depositAddress);
        if (cancelled) return;
        if (!sameQuote(next.quote, record!.quote)) throw Error('Status does not match the reviewed quote. Do not fund this address.');
        setStatus(next); setError('');
        if (!['SUCCESS', 'REFUNDED', 'FAILED', 'UNKNOWN'].includes(next.status) && ++reads < 60) timer = setTimeout(() => void poll(), 5000);
        else setPollStopped(true);
      } catch (e) { if (!cancelled) { setStatus(undefined); setError(e instanceof Error ? e.message : 'Status unavailable. Do not fund again.'); setPollStopped(true); } }
    }
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [record, capabilities?.statusAvailable, pollNonce]);
  async function run(action: () => Promise<void>) {
    if (mutex.current) return;
    mutex.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (e) { if (mounted.current) { setError(e instanceof Error ? e.message : 'Unable to complete this request.'); setTimeout(() => alert.current?.focus(), 0); } }
    finally { mutex.current = false; if (mounted.current) setBusy(false); }
  }
  const displayedQuote = record?.quote ?? quote;
  const expired = !!displayedQuote && Date.parse(displayedQuote.expiresAt) <= clock + 30_000;
  const canFund = record && record.reviewed && !storageError && !expired && status?.status === 'PENDING_DEPOSIT' && clock - Date.parse(status.checkedAt) < 30_000 && capabilities?.enabled;
  const changed = () => { setQuote(undefined); setAccepted(false); };
  const qr = record ? `ethereum:${BASE_USDC_CONTRACT}@8453/transfer?address=${record.quote.depositAddress}&uint256=${record.quote.amountIn}` : '';
  return <section className="card payment-screen integration-screen">
    <span className="eyebrow">AURORA INTENTS</span><h1>Pay from another chain</h1>
    <p>Currently Base USDC → Stellar USDC only. Fees reduce the destination amount; review the quote before funding.</p>
    <div className="integration-notice"><strong>Mainnet · real USDC</strong><p>This route uses Base and Stellar mainnet. It cannot fund your Cherry Testnet wallet. Maximum 100 USDC per payment.</p></div>
    <p><Link to="/recipient-intelligence">Check recipient intelligence</Link> before choosing a payment.</p>
    {configError ? <p role="alert">{configError} <button className="secondary-button" onClick={() => setConfigNonce(n => n + 1)}>Retry availability check</button></p> : !capabilities ? <p role="status">Checking Aurora availability…</p> : !capabilities.enabled && <p className="integration-notice" role="status">Aurora funding is not enabled for this deployment. You can check an existing swap when the status service is available.</p>}
    <p ref={alert} tabIndex={-1} className="error" role="alert">{error || storageError}</p>
    {notice && <p role="status">{notice}</p>}
    {!record && !storageError && <form onSubmit={e => { e.preventDefault(); void run(async () => {
      if (!capabilities?.enabled || readRecord()) throw Error('Funding is disabled or an existing swap needs a status check.');
      const input = { recipient: recipient.trim(), refundTo: refundTo.trim(), amount: amount.trim() };
      validateInput(input); setQuote(undefined); setAccepted(false);
      const next = await auroraClient.quote(input); if (mounted.current) setQuote(next);
    }); }}>
      <fieldset disabled={busy || !capabilities?.enabled || !!quote}><legend>Payment details</legend>
        <label htmlFor="aurora-recipient">Recipient on Stellar mainnet</label><input id="aurora-recipient" value={recipient} onChange={e => { changed(); setRecipient(e.target.value); }} maxLength={56} required autoComplete="off" spellCheck={false} aria-describedby="aurora-recipient-help"/>
        <p id="aurora-recipient-help">A funded personal G-address with Circle USDC enabled. C-addresses, muxed addresses and destinations requiring a memo are unsupported. Confirm the address with the recipient.</p>
        <label htmlFor="aurora-amount">Pay from Base USDC</label><input id="aurora-amount" value={amount} onChange={e => { changed(); setAmount(e.target.value); }} inputMode="decimal" required maxLength={20} aria-describedby="aurora-amount-help"/>
        <p id="aurora-amount-help">Up to 6 decimal places. Your funding wallet also needs Base ETH for gas.</p>
        <label htmlFor="aurora-refund">Your Base refund address</label><input id="aurora-refund" value={refundTo} onChange={e => { changed(); setRefundTo(e.target.value); }} maxLength={42} required autoComplete="off" spellCheck={false} aria-describedby="aurora-refund-help"/>
        <p id="aurora-refund-help">Use a wallet you control that accepts USDC on Base. Refunds may incur fees.</p>
      </fieldset>
      {!quote && <button type="submit" disabled={busy || !capabilities?.enabled}>{busy ? 'Checking route and recipient…' : 'Review Aurora quote'}</button>}
    </form>}
    {displayedQuote && <section aria-label="Aurora quote review"><h2>{record ? 'Saved payment' : 'Review before funding'}</h2><QuoteDetails quote={displayedQuote}/>
      {expired && <p className="error" role="status">The funding window is closed or nearly expired. Do not send funds. {record ? 'Continue checking the existing swap.' : 'Request a new quote.'}</p>}
      {!record && <>
        <label className="check-label"><input type="checkbox" checked={accepted} disabled={busy || expired} onChange={e => setAccepted(e.target.checked)}/> I checked the mainnet recipient, refund address, minimum received, fees and deadline. The recipient does not require a memo.</label>
        <button disabled={busy || !accepted || expired || !capabilities?.enabled} onClick={() => void run(async () => {
          if (!quote || !accepted || !capabilities?.enabled) throw Error('Review an available quote first.');
          assertFresh(quote);
          if (!navigator.locks) throw Error('This browser cannot safely save funding instructions. Use a browser with Web Locks support.');
          await navigator.locks.request(RECOVERY_KEY, async () => {
            if (readRecord()) throw Error('Another tab saved a swap. Reload to check it before funding.');
            const value: Record = { version: 1, quote, reviewed: true };
            localStorage.setItem(RECOVERY_KEY, JSON.stringify(value));
            if (!sameQuote(readRecord()!.quote, quote)) throw Error('Unable to save swap recovery details. Do not fund.');
            if (mounted.current) { setRecord(value); setQuote(undefined); setStatus(undefined); }
          });
        })}>Save and show funding instructions</button>
        <button className="secondary-button" disabled={busy} onClick={changed}>Edit or refresh quote</button>
        <p>Funding instructions appear only after this review and a saved recovery record. Cherry Wallet does not sign or send the Base deposit.</p>
      </>}
    </section>}
    {record && <section aria-label="Aurora swap status"><h2>Swap status</h2>{!record.reviewed && <p>Recovered for status checks only. Do not send another deposit.</p>}<p role="status">{status ? labels[status.status] : 'Status unknown. Wait for a successful status check before funding.'}</p>
      <p className="mono">Recovery deposit address: {record.quote.depositAddress}</p>
      <p>Keep this address separately. Recovery is saved in this browser; clearing browser data removes it. Status checks never send a payment.</p>
      {canFund && <div className="integration-deposit"><h3>Fund once from your Base wallet</h3><p>Send exactly <strong>{units(record.quote.amountIn, 6)} USDC on Base (chain 8453)</strong>. Select native USDC, not ETH or bridged USDbC. Do not use this address for any other asset or network.</p><label htmlFor="aurora-deposit">Base deposit address</label><input id="aurora-deposit" readOnly value={record.quote.depositAddress}/><button onClick={() => void run(async () => { try { await navigator.clipboard.writeText(record.quote.depositAddress); setNotice('Deposit address copied. Select Base USDC in your funding wallet.'); } catch { throw Error('Copy unavailable. Select the deposit address and copy it manually.'); } })}>Copy deposit address</button><div className="receive-qr"><QRCodeSVG value={qr} size={192} title="Base mainnet USDC transfer request"/></div><p>The QR encodes the Base USDC contract, chain, destination and exact amount. Verify these in your funding wallet before approving.</p></div>}
      {status && <><p>Provider status checked {new Date(status.checkedAt).toLocaleString()}. Cherry has not independently verified Stellar settlement.</p>{status.amountOut !== null && <p>Provider-reported output: {units(status.amountOut, 7)} USDC.</p>}{status.originTxHashes.map(h => <p key={h}><a target="_blank" rel="noreferrer" href={`https://basescan.org/tx/${h}`}>Base deposit receipt</a></p>)}{status.destinationTxHashes.map(h => <p key={h}><a target="_blank" rel="noreferrer" href={`https://stellar.expert/explorer/public/tx/${h}`}>Stellar mainnet receipt</a></p>)}</>}
      {pollStopped && <p>Automatic status checks have paused. You can resume them below.</p>}
      <button className="secondary-button" disabled={!capabilities?.statusAvailable} onClick={() => { setStatus(undefined); setPollNonce(n => n + 1); }}>Check existing swap status</button>
      {status && ['SUCCESS', 'REFUNDED'].includes(status.status) && <button className="secondary-button" onClick={() => void run(async () => {
        if (!navigator.locks) throw Error('Use a browser with Web Locks support to finish this record.');
        await navigator.locks.request(RECOVERY_KEY, async () => {
          const saved = readRecord(); if (!saved || !sameQuote(saved.quote, record.quote)) throw Error('Saved swap changed. Reload before continuing.');
          localStorage.removeItem(RECOVERY_KEY); setRecord(null); setStatus(undefined); setAccepted(false); setAmount('');
        });
      })}>Finish viewing this swap</button>}
      <p>Do not create a replacement or top up an incomplete deposit. For an uncertain or failed outcome, keep the deposit address and source receipt for <a href="https://docs.intents.aurora.dev/getting-started/integration-best-practices/handling-support-cases" target="_blank" rel="noreferrer">Aurora support</a>.</p>
    </section>}
    {!record && <details><summary>Recover an existing swap</summary><form onSubmit={e => { e.preventDefault(); void run(async () => {
      if (!capabilities?.statusAvailable || !evmAddress(recoveryAddress.trim())) throw Error('Enter the existing Base deposit address when the status service is available.');
      const recovered = await auroraClient.status(recoveryAddress.trim());
      if (!mounted.current) return;
      // Save imported recovery as read-only, preventing a new quote on reload.
      if (storageError) { setStatus(recovered); return; }
      if (!navigator.locks) throw Error('Use a browser with Web Locks support to save this recovery record.');
      await navigator.locks.request(RECOVERY_KEY, async () => {
        if (readRecord()) throw Error('A saved swap already exists. Reload to check it.');
        const value: Record = { version: 1, quote: recovered.quote, reviewed: false };
        localStorage.setItem(RECOVERY_KEY, JSON.stringify(value));
        setRecord(value); setStatus(recovered); setQuote(undefined);
      });
    }); }}><label htmlFor="aurora-recovery">Original Base deposit address</label><input id="aurora-recovery" disabled={busy} value={recoveryAddress} onChange={e => { setRecoveryAddress(e.target.value); setStatus(undefined); }} required maxLength={42}/><button disabled={busy || !capabilities?.statusAvailable}>Recover status only</button></form>{status && <div role="status"><p>{labels[status.status]}</p><QuoteDetails quote={status.quote}/><p>Read-only recovery. No new funding instructions are generated. Keep this deposit address when contacting support.</p></div>}</details>}
  </section>;
}
function QuoteDetails({ quote }: { quote: AuroraQuote }) {
  const difference = BigInt(quote.amountIn) * 10n - BigInt(quote.amountOut);
  return <dl><dt>Route</dt><dd>Base mainnet USDC → Stellar mainnet USDC</dd><dt>Recipient</dt><dd>{quote.recipient}</dd><dt>Refunds to your Base wallet</dt><dd>{quote.refundTo}</dd><dt>You fund exactly</dt><dd>{units(quote.amountIn, 6)} USDC</dd><dt>Expected recipient amount, after fees</dt><dd>{units(quote.amountOut, 7)} USDC</dd><dt>Minimum recipient amount</dt><dd>{units(quote.minAmountOut, 7)} USDC</dd><dt>Input less expected output (fees and price difference)</dt><dd>{difference < 0n ? '−' : ''}{units((difference < 0n ? -difference : difference).toString(), 7)} USDC</dd><dt>Withdrawal fee, already included in output</dt><dd>{quote.withdrawFee === null ? 'Not separately reported by Aurora' : `${units(quote.withdrawFee, 7)} USDC`}</dd><dt>Possible refund fee</dt><dd>{quote.refundFee === null ? 'Not separately reported by Aurora' : `${units(quote.refundFee, 6)} USDC`}</dd><dt>Slippage limit</dt><dd>1%</dd><dt>Fund before</dt><dd>{new Date(quote.expiresAt).toLocaleString()}</dd><dt>Base transfer gas</dt><dd>Additional ETH paid by your funding wallet</dd></dl>;
}
