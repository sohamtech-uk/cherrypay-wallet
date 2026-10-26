import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { NETWORK, statusLabel, xlm, type Attempt, type PaymentAdapter } from './model';

export function PaymentAttention({ adapter }: { adapter: PaymentAdapter }) {
  const [items, setItems] = useState<Attempt[]>([]), [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await adapter.listAttempts();
        if (!result || result.items.some(i => i.network !== NETWORK || i.from !== adapter.address)) throw Error('Invalid attempts');
        result.items.forEach(i => xlm(i.amountStroops));
        if (active) { setItems(result.items.filter(i => ['awaiting_approval','pending','submitted','unknown'].includes(i.status) || i.status === 'confirmed' && !i.verified)); setUnavailable(false); }
      } catch { if (active) setUnavailable(true); }
      if (active) timer = setTimeout(() => void load(), 15000);
    }
    void load(); return () => { active = false; clearTimeout(timer); };
  }, [adapter]);
  if (!items.length && !unavailable) return null;
  return <section className="card attention-card" aria-label="Payments needing attention"><h2>Payment follow-up</h2>
    {unavailable && <p>Payment status could not be refreshed. Check activity before starting another payment.</p>}
    {items.slice(0, 3).map(i => <div className="attention-row" key={i.id}><div><strong>{xlm(i.amountStroops)} XLM</strong><p>{statusLabel(i)}</p></div><Link className="secondary-button" to={`/history/${encodeURIComponent(i.id)}`}>View status</Link></div>)}
    <Link className="text-link" to="/send">Continue or recover saved payment →</Link>
  </section>;
}
