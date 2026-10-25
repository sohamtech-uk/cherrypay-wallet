import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Link } from 'react-router-dom';
import { addressKind, NETWORK } from './model';
import { usePayments } from './context';
export function Receive() {
  const adapter = usePayments();
  const route = adapter?.receive;
  const valid = adapter?.network === NETWORK && route && addressKind(route.address) === route.route && route.address === adapter.address;
  const [message, setMessage] = useState('');
  return <section className="card payment-screen"><span className="eyebrow">TESTNET XLM</span><h1>Receive XLM</h1><p>Testnet funds have no real-world value. Only use the supported route shown here.</p>{valid ? <>
    <h2>{route.route === 'contract' ? 'Smart-wallet transfer' : 'Classic account transfer'}</h2><p>{route.instructions}</p>
    <p>{route.route === 'contract' ? 'Use a sender that supports native XLM SAC transfers to this contract. Do not use a classic payment operation or an exchange withdrawal.' : 'Use a Stellar Testnet sender that supports classic account XLM payments. Do not send mainnet assets.'}</p>
    <div className="receive-qr"><QRCodeSVG value={route.address} size={224} level="M" title="Stellar Testnet destination address"/></div>
    <p>The QR contains the address only. Confirm Stellar Testnet and the transfer route in the sending app.</p>
    <label htmlFor="receive-address">Your supported Testnet destination</label><textarea id="receive-address" readOnly value={route.address} rows={3}/>
    <button onClick={async () => { try { await navigator.clipboard.writeText(route.address); setMessage('Address copied.'); } catch { setMessage('Copy unavailable. Select the address above and copy it manually.'); } }}>Copy address</button>
    <p role="status">{message}</p>
  </> : <><h2>Receive route not connected</h2><p>The wallet service must confirm your destination and supported funding route before we show an address or QR. A watch-only address does not establish wallet ownership.</p><Link className="secondary-button" to="/onboarding">Return to wallet setup</Link></>}</section>;
}
