import { useEffect, useState } from 'react';
import { loadBalance, validateClassicAddress } from './wallet';
const storageKey = 'cherrypay:testnet:watch-address';
function savedAddress() { try { const value = sessionStorage.getItem(storageKey) ?? ''; return validateClassicAddress(value) ? value : ''; } catch { return ''; } }
export function WatchAccount() {
  const [address, setAddress] = useState(savedAddress), [input, setInput] = useState(savedAddress);
  const [balance, setBalance] = useState<string>(), [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setBalance(undefined); setError('');
    if (!address) { setBusy(false); return; }
    const controller = new AbortController(); setBusy(true);
    loadBalance(address, controller.signal).then(value => { if (!controller.signal.aborted) setBalance(value); }).catch(() => { if (!controller.signal.aborted) setError('Unable to read this Testnet account. It may be unfunded, or the network may be unavailable.'); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [address, refresh]);
  function watch(event: React.FormEvent) {
    event.preventDefault(); const value = input.trim();
    if (!validateClassicAddress(value)) { setError('Enter a checksum-valid classic Stellar G-address. Sign in above for a linked smart wallet.'); return; }
    setAddress(value); setRefresh(v => v + 1);
    try { sessionStorage.setItem(storageKey, value); } catch { /* Watching does not require storage. */ }
  }
  return <div className="payment-screen">
    <p>Watch-only lookup gives no spending access. It does not connect a passkey wallet.</p>
    <form onSubmit={watch}><label htmlFor="watch-address">Classic Testnet account address</label><input id="watch-address" value={input} onChange={e => setInput(e.target.value)} placeholder="G…" required spellCheck={false} autoComplete="off"/><button disabled={busy} type="submit">{busy ? 'Loading…' : 'View account'}</button></form>
    {address && <p className="mono">Watching {address}</p>}
    {balance !== undefined && <p className="wallet-amount">{balance} XLM · watch-only</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {address && <button className="secondary-button" onClick={() => { setAddress(''); setInput(''); try { sessionStorage.removeItem(storageKey); } catch { /* Storage disabled. */ } }}>Clear watched account</button>}
  </div>;
}
