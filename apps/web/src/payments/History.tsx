import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { filterActivity, downloadActivity } from './activity';
import { usePayments } from './context';
import { explorerLink, NETWORK, statusLabel, xlm, type Attempt } from './model';
export function History() {
  const adapter = usePayments();
  const { attemptId } = useParams();
  const [items, setItems] = useState<Attempt[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<string>();
  const [indexed, setIndexed] = useState(!!adapter?.listTransfers);
  const [direction, setDirection] = useState('all'), [query, setQuery] = useState('');
  const visible = filterActivity(items, adapter?.address ?? '', direction, query);
  useEffect(() => {
    let active = true;
    setItems([]); setCursor(undefined); setError('');
    if (!adapter || adapter.network !== NETWORK) return;
    setBusy(true);
    const request = attemptId ? adapter.getAttempt(attemptId).then(item => ({ items: [item], nextCursor: undefined })) : indexed && adapter.listTransfers ? adapter.listTransfers(page) : adapter.listAttempts(page);
    request.then(result => { if (!active) return; if (result.items.some(item => item.network !== NETWORK || item.from !== adapter.address && item.destination !== adapter.address)) throw new Error('History does not match this Testnet wallet.'); if (indexed && !attemptId && result.items.some(item => !explorerLink(item))) throw new Error('Unverified transfer.'); result.items.forEach(item => xlm(item.amountStroops)); setItems(result.items); setCursor(result.nextCursor); }).catch(() => { if (active) setError('Unable to load transaction records. Check your connection and retry.'); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [adapter, attemptId, refresh, page, indexed]);
  const currentStatus = items[0]?.status;
  useEffect(() => {
    if (!adapter || adapter.network !== NETWORK || !attemptId) return;
    if (!currentStatus || !['submitted','pending','unknown'].includes(currentStatus)) return;
    let active = true, inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const item = await adapter.getAttempt(attemptId);
        if (!active) return;
        if (item.network !== NETWORK || item.from !== adapter.address && item.destination !== adapter.address) throw new Error('History does not match this Testnet wallet.');
        setItems([item]); setError('');
      } catch {
        // Preserve the last known state; a later interval or manual refresh retries.
      } finally { inFlight = false; }
    };
    const timer = window.setInterval(() => void poll(), 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [adapter, attemptId, currentStatus]);
  return <section className="card payment-screen activity-screen"><span className="eyebrow">YOUR PAYMENTS</span><h1>{attemptId ? 'Transaction detail' : 'Transaction history'}</h1>
    {!adapter || adapter.network !== NETWORK ? <><h2>History service not connected</h2><p>Verified activity will appear once the persistent wallet index is connected. No sample transactions are shown.</p><Link className="secondary-button" to="/onboarding">Return to wallet setup</Link></> : <>
      {!attemptId && adapter.listTransfers && <div className="segmented-control"><button aria-pressed={!indexed} onClick={() => { setIndexed(false); setPage(undefined); }}>Payment attempts</button><button aria-pressed={indexed} onClick={() => { setIndexed(true); setPage(undefined); }}>Verified transfers</button></div>}
      {!attemptId && <><div className="activity-filters"><div><label htmlFor="activity-search">Search this page</label><input id="activity-search" type="search" placeholder="Address, transaction or reference" value={query} onChange={e=>setQuery(e.target.value)}/></div><div><label htmlFor="activity-direction">Direction</label><select id="activity-direction" value={direction} onChange={e=>setDirection(e.target.value)}><option value="all">All payments</option><option value="sent">Sent</option><option value="received">Received</option></select></div></div>{indexed && <button className="secondary-button" disabled={busy || !visible.length || !!error} onClick={()=>{try{downloadActivity(visible,adapter.address);}catch{setError('Unable to export these records. Refresh and try again.');}}}>Export displayed transfers (CSV)</button>}<p className="small-copy">Filters and export apply to this page only.</p></>}
      {busy && <p role="status">Loading transaction records…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {attemptId && items[0] && ['submitted','pending','unknown'].includes(items[0].status) && <p role="status">Status refreshes automatically every 5 seconds until the transaction is confirmed or fails.</p>}
      <button className="secondary-button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{error ? 'Retry loading' : 'Refresh status'}</button>
      {!busy && !error && !items.length && <p>No transactions yet. Received and sent XLM will appear after indexing.</p>}
      {!busy && !error && items.length > 0 && !visible.length && <p>No payments match these filters on this page.</p>}
      <ul className="transaction-list">{(attemptId ? items : visible).map(item => <li key={item.id}><article><h2>{item.from === adapter.address ? 'Sent' : 'Received'} {xlm(item.amountStroops)} XLM</h2><p role="status">{statusLabel(item)}</p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
        {attemptId ? <><dl><dt>Attempt ID</dt><dd>{item.id}</dd><dt>Network</dt><dd>Stellar Testnet</dd><dt>From</dt><dd>{item.from}</dd><dt>Recipient</dt><dd>{item.destination}</dd><dt>Authorized maximum network fee</dt><dd>{item.feeKnown === false ? 'Not available' : `${xlm(item.feeStroops)} XLM`}</dd><dt>Transaction hash</dt><dd>{item.transactionHash || 'Not available yet'}</dd></dl><p>{item.failureMessage}</p>{explorerLink(item) ? <a className="secondary-button" href={explorerLink(item)} target="_blank" rel="noreferrer">Open verified Testnet receipt</a> : <p>A receipt link is available only after independent transfer verification.</p>}</> : indexed ? <><details className="disclosure"><summary>Payment addresses & reference</summary><p className="mono">From: {item.from}</p><p className="mono">To: {item.destination}</p><p className="mono">Transfer ID: {item.id}</p>{item.paymentRequestId && <p className="mono">Invoice request: {item.paymentRequestId}</p>}</details><a className="secondary-button" href={explorerLink(item)} target="_blank" rel="noreferrer">Verified Testnet receipt</a><Link className="secondary-button" to={`/send?to=${encodeURIComponent(item.from === adapter.address ? item.destination : item.from)}`}>Send to this wallet</Link></> : <Link className="secondary-button" to={`/history/${encodeURIComponent(item.id)}`}>View transaction</Link>}
      </article></li>)}</ul>
      {!attemptId && cursor && <button disabled={busy} onClick={() => setPage(cursor)}>Next page</button>}{!attemptId && page && <button className="secondary-button" disabled={busy} onClick={() => setPage(undefined)}>Back to latest</button>}
    </>}{attemptId && <Link className="secondary-button" to="/history">Back to history</Link>}
  </section>;
}

