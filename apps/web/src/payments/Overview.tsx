import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePayments } from './context';
import { explorerLink, NETWORK, xlm, type Attempt, type PaymentAdapter } from './model';
import { WatchAccount } from '../WatchAccount';

type Snapshot = Awaited<ReturnType<NonNullable<PaymentAdapter['getBalance']>>>;
function WalletOverview({ adapter }: { adapter: PaymentAdapter }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(null);
  const [items, setItems] = useState<Attempt[]>([]);
  const [balanceError, setBalanceError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let active = true;
    setLoading(true); setSnapshot(null); setItems([]); setBalanceError(''); setHistoryError('');
    const balance = async () => {
      try {
        if (!adapter.getBalance) throw Error('Balance indexing is not available for this connection.');
        const value = await adapter.getBalance();
        if (value) {
          xlm(value.amountStroops);
          if (!Number.isSafeInteger(value.ledger) || value.ledger <= 0 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt <= 0 || value.updatedAt > Date.now() + 5000) throw Error('Invalid balance snapshot.');
        }
        if (active) setSnapshot(value);
      } catch { if (active) setBalanceError('Unable to load the indexed balance. Refresh to try again.'); }
    };
    const history = async () => {
      try {
        if (!adapter.listTransfers) throw Error('Verified activity is not available for this connection.');
        const result = await adapter.listTransfers();
        if (result.items.some(item => item.network !== NETWORK || item.from !== adapter.address && item.destination !== adapter.address || !explorerLink(item) || !Number.isFinite(Date.parse(item.createdAt)))) throw Error('Unverified activity.');
        result.items.forEach(item => xlm(item.amountStroops));
        if (active) setItems(result.items.slice(0, 5));
      } catch { if (active) setHistoryError('Unable to load verified activity. Refresh to try again.'); }
    };
    void Promise.allSettled([balance(), history()]).then(() => { if (active) { setLoading(false); setNow(Date.now()); } });
    const clock = setInterval(() => setNow(Date.now()), 10000);
    return () => { active = false; clearInterval(clock); };
  }, [adapter, refresh]);
  return <>
    <section className="card payment-screen" aria-label="Connected wallet overview">
      <h2>Your Testnet wallet</h2><p className="mono">{adapter.address}</p>
      <h3>Indexed XLM balance</h3>
      <p className="wallet-amount">{snapshot ? `${xlm(snapshot.amountStroops)} XLM` : '—'}</p>
      {snapshot && <><p>Ledger {snapshot.ledger} · Updated <time dateTime={new Date(snapshot.updatedAt).toISOString()}>{new Date(snapshot.updatedAt).toLocaleString()}</time></p>{now - snapshot.updatedAt > 60000 && <p role="status">This balance is over a minute old. Refresh before planning a payment.</p>}<p>A payment preview checks the current spendable balance and maximum fee.</p></>}
      {!loading && !snapshot && !balanceError && <p>Balance awaiting indexing. No zero balance has been assumed.</p>}
      {balanceError && <p role="alert" className="error">{balanceError}</p>}
      {loading && <p role="status">Loading wallet overview…</p>}
      <button disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh overview</button>
      <div className="actions"><Link className="secondary-button" to="/receive">Receive XLM</Link><Link className="secondary-button" to="/send">Send XLM</Link></div>
    </section>
    <section className="card payment-screen" aria-label="Recent verified activity">
      <h2>Recent verified activity</h2>
      {historyError && <p role="alert" className="error">{historyError}</p>}
      {!loading && !historyError && !items.length && <p>No verified transfers indexed yet.</p>}
      <ul className="transaction-list">{items.map(item => <li key={item.id}>
        <h3>{item.from === adapter.address ? 'Sent' : 'Received'} {xlm(item.amountStroops)} XLM</h3>
        <p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></p>
        <a className="secondary-button" href={explorerLink(item)} target="_blank" rel="noreferrer">Verified Testnet receipt</a>
      </li>)}</ul>
      <Link className="secondary-button" to="/history">View all activity and payment attempts</Link>
    </section>
  </>;
}
export function Overview() {
  const adapter = usePayments();
  return <>
    <div className="heading"><div><span className="eyebrow">WALLET OVERVIEW</span><h1>Your Stellar Testnet wallet</h1><p>Testnet funds have no real-world value.</p></div><Link className="secondary-button" to="/onboarding">Wallet setup</Link></div>
    {adapter?.network === NETWORK ? <WalletOverview key={adapter.address} adapter={adapter}/> : <>
      <section className="card"><h2>Connect your passkey profile</h2><p>Sign in above to see your linked wallet’s balance and verified transfers. New profiles need pilot activation before receiving or sending Testnet XLM.</p></section>
      <details className="card"><summary>Watch a classic Testnet account</summary><WatchAccount/></details>
    </>}
  </>;
}
