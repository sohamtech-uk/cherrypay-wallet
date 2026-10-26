import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useWalletAccount } from './account-context';

export function FundingPrompt() {
  const account = useWalletAccount();
  const [error, setError] = useState('');
  const funding = account?.deployment?.funding;
  if (!account?.authenticated || !account.deployment?.address || funding?.status === 'FUNDED') return null;
  const pending = funding?.status === 'PENDING' || funding?.status === 'SUBMITTED';
  const review = funding?.status === 'FAILED' || funding?.status === 'REVIEW_REQUIRED';
  return <section className="card funding-prompt" aria-label="Testnet funding">
    <div><h2>{pending ? 'Your test funds are on the way' : review ? 'Funding needs review' : 'Try your wallet with 10,000 XLM'}</h2><p>{pending ? 'Waiting for confirmation. Your request will not be repeated.' : review ? 'Open settings to check the existing funding request.' : 'Get your one-time Testnet allocation, then try sending a payment.'}</p></div>
    {!pending && !review && funding && <button disabled={account.busy} onClick={async () => { setError(''); try { await account.fundTestnet(); } catch { setError('Unable to request funding. Check wallet status before retrying.'); } }}>Fund Testnet wallet</button>}
    {(pending || review || !funding) && <Link className="secondary-button" to="/profile">View wallet status</Link>}
    {(error || account.error) && <p role="alert" className="error">{error || account.error}</p>}
  </section>;
}
