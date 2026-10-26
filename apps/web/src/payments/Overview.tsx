import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, Clock3, Copy, RefreshCw, ShieldCheck } from 'lucide-react';
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
  const [copyStatus, setCopyStatus] = useState('');
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
  return <div className="wallet-home">
    <section className="card wallet-hero" aria-label="Connected wallet overview">
      <div className="wallet-hero-top"><span className="wallet-kicker">TOTAL WALLET BALANCE</span><span className="wallet-network"><ShieldCheck size={15}/> Stellar Testnet</span></div>
      <div className="wallet-hero-balance">{snapshot ? <>{xlm(snapshot.amountStroops)} <span>XLM</span></> : '—'}</div>
      {loading && <p role="status">Loading wallet overview…</p>}
      {!loading && !snapshot && !balanceError && <p>Balance awaiting indexing. No zero balance has been assumed.</p>}
      {balanceError && <p role="alert" className="error">{balanceError}</p>}
      {snapshot && <div className="wallet-balance-meta">Verified ledger {snapshot.ledger} · Updated <time dateTime={new Date(snapshot.updatedAt).toISOString()}>{new Date(snapshot.updatedAt).toLocaleString()}</time>{now - snapshot.updatedAt > 60000 && <p role="status">This balance is over a minute old. Refresh before planning a payment.</p>}</div>}
      <div className="wallet-hero-actions"><Link to="/send" className="wallet-primary-action"><ArrowUpRight size={18}/> Send XLM</Link><Link to="/receive" className="wallet-primary-action wallet-receive-action"><ArrowDownLeft size={18}/> Receive XLM</Link><button className="wallet-refresh" aria-label="Refresh overview" disabled={loading} onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={18}/></button></div>
    </section>
    <section className="card wallet-address-card">
      <div className="wallet-card-heading"><div><span className="eyebrow">YOUR WALLET</span><h2>Stellar smart wallet</h2></div><span className="wallet-pill">Testnet</span></div>
      <p>Wallet address</p><div className="wallet-address-row"><code className="mono">{adapter.address}</code><button className="secondary-button" onClick={async()=>{try{await navigator.clipboard.writeText(adapter.address);setCopyStatus('Wallet address copied.');}catch{setCopyStatus('Copy unavailable. Select the address to copy manually.');}}}><Copy size={16}/> Copy</button></div><p role="status">{copyStatus}</p>
      <p>Payments use a verified wallet address and require passkey approval. Testnet XLM has no monetary value.</p>
    </section>
    <section className="card wallet-activity" aria-label="Recent verified activity">
      <div className="wallet-card-heading"><div><span className="eyebrow">ACTIVITY</span><h2>Recent transactions</h2></div><Link to="/history" className="secondary-button">View all <Clock3 size={15}/></Link></div>
      {historyError && <p role="alert" className="error">{historyError}</p>}
      {!loading && !historyError && !items.length && <p>No verified transfers indexed yet.</p>}
      <ul className="transaction-list">{items.map(item=><li className="wallet-activity-item" key={item.id}>
        <span className={item.from === adapter.address ? 'activity-icon sent' : 'activity-icon received'}>{item.from===adapter.address ? <ArrowUpRight size={19}/> : <ArrowDownLeft size={19}/>}</span>
        <div className="wallet-activity-text"><h3>{item.from===adapter.address?'Sent':'Received'} {xlm(item.amountStroops)} XLM</h3><p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></p></div>
        <a className="wallet-receipt" href={explorerLink(item)} target="_blank" rel="noreferrer">Verified Testnet receipt</a>
      </li>)}</ul>
      <Link className="secondary-button" to="/history">View all activity and payment attempts</Link>
    </section>
  </div>;
}
export function Overview() {
  const adapter = usePayments();
  return <>
    <div className="heading"><div><span className="eyebrow">GOOD TO SEE YOU</span><h1>Wallet dashboard</h1><p>Manage your XLM balance and payments on Stellar Testnet.</p></div><Link className="secondary-button" to="/onboarding">Wallet setup</Link></div>
    {adapter?.network === NETWORK ? <WalletOverview key={adapter.address} adapter={adapter}/> : <>
      <section className="card"><h2>Connect your passkey profile</h2><p>Sign in above to see your linked wallet’s balance and verified transfers. New profiles need pilot activation before receiving or sending Testnet XLM.</p></section>
      <details className="card"><summary>Watch a classic Testnet account</summary><WatchAccount/></details>
    </>}
  </>;
}
