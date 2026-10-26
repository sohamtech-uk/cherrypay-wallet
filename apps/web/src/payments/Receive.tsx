import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Link } from 'react-router-dom';
import { addressKind, explorerLink, NETWORK, xlm, type Attempt, type PaymentAdapter } from './model';
import { usePayments } from './context';
export function Receive() {
  const adapter = usePayments();
  const route = adapter?.receive;
  const valid = adapter?.network === NETWORK && route && addressKind(route.address) === route.route && route.address === adapter.address;
  const [message, setMessage] = useState('');
  return <section className="card payment-screen"><span className="eyebrow">TESTNET XLM</span><h1>Receive XLM</h1><p>Testnet funds have no real-world value. Only use the supported route shown here.</p>{valid ? <>
    <h2>{route.route === 'contract' ? 'Smart-wallet transfer' : 'Classic account transfer'}</h2><p>{route.instructions}</p>
    <p>{route.route === 'contract' ? 'Anyone can send Testnet XLM using a wallet or tool that supports native XLM SAC transfers to this C-address. The sender does not need a Cherry Pay account. Classic G-address payments and exchange withdrawals cannot target this contract.' : 'Use a Stellar Testnet sender that supports classic account XLM payments. Do not send mainnet assets.'}</p>
    <div className="receive-qr"><QRCodeSVG value={route.address} size={224} level="M" title="Stellar Testnet destination address"/></div>
    <p>The QR contains the address only. Confirm Stellar Testnet and the transfer route in the sending app.</p>
    <label htmlFor="receive-address">Your supported Testnet destination</label><textarea id="receive-address" readOnly value={route.address} rows={3}/>
    <button onClick={async () => { try { await navigator.clipboard.writeText(route.address); setMessage('Address copied.'); } catch { setMessage('Copy unavailable. Select the address above and copy it manually.'); } }}>Copy address</button>
    <p role="status">{message}</p>
    <ReceiveActivity key={adapter.address} adapter={adapter}/>
  </> : <><h2>Receive route not connected</h2><p>The wallet service must confirm your destination and supported funding route before we show an address or QR. A watch-only address does not establish wallet ownership.</p><Link className="secondary-button" to="/onboarding">Return to wallet setup</Link></>}</section>;
}


function ReceiveActivity({adapter}:{adapter:PaymentAdapter}) {
  const [snapshot,setSnapshot]=useState<Awaited<ReturnType<NonNullable<PaymentAdapter['getBalance']>>>>(null);
  const [incoming,setIncoming]=useState<Attempt[]>([]);
  const [balanceError,setBalanceError]=useState(''),[historyError,setHistoryError]=useState('');
  const [loading,setLoading]=useState(true),[refresh,setRefresh]=useState(0);
  useEffect(()=>{
    let active=true,timer:ReturnType<typeof setTimeout>;
    async function update(){
      setLoading(true);
      await Promise.allSettled([
        (async()=>{try{
          if(!adapter.getBalance)throw Error('Balance unavailable');
          const value=await adapter.getBalance();
          if(!value||!Number.isSafeInteger(value.ledger)||value.ledger<1||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<1||value.updatedAt>Date.now()+5000)throw Error('Invalid balance');
          xlm(value.amountStroops);
          if(active){setSnapshot(value);setBalanceError('');}
        }catch{if(active){setSnapshot(null);setBalanceError('Balance could not be refreshed. Check again.');}}})(),
        (async()=>{try{
          if(!adapter.listTransfers)throw Error('History unavailable');
          const result=await adapter.listTransfers();
          if(result.items.some(item=>item.network!==NETWORK||!explorerLink(item)||(item.from!==adapter.address&&item.destination!==adapter.address)||!Number.isFinite(Date.parse(item.createdAt))))throw Error('Unverified transfer');
          result.items.forEach(item=>xlm(item.amountStroops));
          if(active){setIncoming(result.items.filter(item=>item.destination===adapter.address&&item.from!==adapter.address).slice(0,5));setHistoryError('');}
        }catch{if(active){setIncoming([]);setHistoryError('Received-transfer history could not be refreshed. Check again.');}}})()
      ]);
      if(active){setLoading(false);timer=setTimeout(()=>void update(),15000);}
    }
    void update();
    return()=>{active=false;clearTimeout(timer);};
  },[adapter,refresh]);
  return <section aria-label="Incoming Testnet XLM">
    <h2>Incoming XLM</h2><p>Balance and verified transfers refresh automatically while this page is open. No payment approval is needed to receive.</p>
    <h3>Current Testnet balance</h3><p className="wallet-amount">{snapshot?`${xlm(snapshot.amountStroops)} XLM`:'—'}</p>
    {snapshot&&<p>Checked at ledger {snapshot.ledger} · <time dateTime={new Date(snapshot.updatedAt).toISOString()}>{new Date(snapshot.updatedAt).toLocaleTimeString()}</time></p>}
    {balanceError&&<p role="alert">{balanceError}</p>}{historyError&&<p role="alert">{historyError}</p>}
    <button className="secondary-button" disabled={loading} onClick={()=>setRefresh(n=>n+1)}>{loading?'Checking for received XLM…':'Check for received XLM'}</button>
    {!loading&&!historyError&&!incoming.length&&<p>No verified incoming transfers indexed yet. Your balance may update before the transfer receipt appears.</p>}
    <ul className="transaction-list">{incoming.map(item=><li key={item.id}><h3>Received {xlm(item.amountStroops)} XLM</h3><p className="mono">From: {item.from}</p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time><p><a href={explorerLink(item)} target="_blank" rel="noreferrer">Verified Testnet receipt</a></p></li>)}</ul>
    <Link className="secondary-button" to="/history">View transaction history</Link>
  </section>;
}
