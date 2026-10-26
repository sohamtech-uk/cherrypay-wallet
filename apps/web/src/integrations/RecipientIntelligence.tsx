import { useEffect, useRef, useState } from 'react';
import { StrKey } from '@stellar/stellar-sdk';
import { Link } from 'react-router-dom';
import { loadRecipientIntelligence, type RecipientIntelligence as Result } from './client';

export function RecipientIntelligence() {
  const [address, setAddress] = useState('');
  const [network, setNetwork] = useState<'MAINNET' | 'TESTNET'>('TESTNET');
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function invalidate() { pending.current?.abort(); pending.current = undefined; setResult(undefined); setError(''); setBusy(false); }
  const valid = StrKey.isValidEd25519PublicKey(address.trim()) || StrKey.isValidContract(address.trim());
  async function check() {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError(''); setResult(undefined);
    try { const value = await loadRecipientIntelligence(address, network, controller.signal); if (!controller.signal.aborted) setResult(value); }
    catch (e) { if (!controller.signal.aborted) { setError(e instanceof Error ? e.message : 'Recipient check unavailable.'); setTimeout(() => alert.current?.focus(), 0); } }
    finally { if (pending.current === controller) { pending.current = undefined; setBusy(false); } }
  }
  return <section className="card payment-screen integration-screen">
    <span className="eyebrow">NANSEN AI · RECIPIENT INTELLIGENCE</span><h1>Know your recipient</h1>
    <p>Check availability of Nansen intelligence for a Stellar address before entering a payment flow. This read-only screen does not sign, fund or send anything.</p>
    <div className="integration-notice"><strong>Stellar coverage is unavailable</strong><p>Nansen’s published API does not currently support Stellar recipient intelligence. This check validates the address format and reports coverage; it cannot provide a Nansen risk assessment.</p></div>
    <form onSubmit={e => { e.preventDefault(); void check(); }}>
      <label htmlFor="intelligence-network">Stellar network</label><select id="intelligence-network" value={network} onChange={e => { invalidate(); setNetwork(e.target.value as typeof network); }}><option value="MAINNET">Mainnet</option><option value="TESTNET">Testnet</option></select>
      <label htmlFor="intelligence-address">Stellar recipient address</label><input id="intelligence-address" value={address} maxLength={56} autoComplete="off" spellCheck={false} onChange={e => { invalidate(); setAddress(e.target.value); }} aria-invalid={!!address && !valid} aria-describedby="intelligence-address-help" required/>
      <p id="intelligence-address-help">{address && !valid ? 'Enter a valid G-address or C-address with a valid checksum.' : 'An address alone does not identify its network or owner.'}</p>
      <button disabled={!valid || busy} type="submit">{busy ? 'Checking availability…' : 'Check recipient intelligence'}</button>
    </form>
    <p className="error" role="alert" ref={alert} tabIndex={-1}>{error}</p>
    {result && <section aria-label="Recipient intelligence result" role="status"><h2>No Nansen assessment available</h2><dl><dt>Address</dt><dd>{result.address}</dd><dt>Network selected</dt><dd>Stellar {result.network === 'MAINNET' ? 'Mainnet' : 'Testnet'}</dd><dt>Provider coverage</dt><dd>Unsupported · no address sent to Nansen</dd></dl><p>{result.message}</p><p>{result.notice}</p><p>Provider coverage documentation checked {result.coverageVerifiedAt}. This is not a clearance to pay.</p></section>}
    <a href="https://docs.nansen.ai/reference/chains" target="_blank" rel="noreferrer">Nansen supported chains</a>
    <p><Link to="/pay-from-another-chain">Open cross-chain payment form</Link> · <Link to="/send">Open Testnet XLM payment form</Link></p>
  </section>;
}
