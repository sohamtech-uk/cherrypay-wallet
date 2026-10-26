import { useEffect, useMemo, useState } from 'react';
import { BookOpen, ClipboardCopy, Code2, ExternalLink, RefreshCw, Search } from 'lucide-react';

type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Operation = {
  summary?: string;
  description?: string;
  security?: { WalletSession?: unknown[] }[];
};
type Document = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Partial<Record<HttpMethod, Operation>>>;
};
type Entry = { key: string; path: string; method: HttpMethod; title: string; description: string; auth: boolean; group: string };
type Runtime = { status: string; network: string; walletDeploymentEnabled: boolean; walletPaymentsEnabled: boolean };
const methods: HttpMethod[] = ['get','post','put','patch','delete'];
const sections = ['Authentication', 'Smart wallet', 'Transfers & activity', 'Invoices & checkout', 'Payroll', 'Integrations', 'Service status'];
function groupFor(path: string): string {
  if (path.includes('/invoices') || path.includes('/unmatched-receipts') || path.includes('/payment-requests')) return 'Invoices & checkout';
  if (path.includes('/payroll')) return 'Payroll';
  if (path.includes('/passkeys/') || path.includes('/session/') || path === '/api/v1/wallet/me') return 'Authentication';
  if (path.startsWith('/api/v1/smart-account/') || path === '/api/v1/wallets' || /^\/api\/v1\/wallets\/\{walletId\}$/.test(path)) return 'Smart wallet';
  if (path.startsWith('/api/v1/aurora/') || path.startsWith('/api/v1/intelligence/')) return 'Integrations';
  if (path === '/health' || path === '/ready' || path === '/api/v1/network') return 'Service status';
  return 'Transfers & activity';
}
function decode(value: unknown): Document {
  if (!value || typeof value !== 'object') throw Error('API reference is unavailable.');
  const doc = value as Partial<Document>;
  if (!/^3\./.test(doc.openapi ?? '') || !doc.info || typeof doc.info.title !== 'string' || !doc.paths || typeof doc.paths !== 'object') {
    throw Error('The API returned an invalid reference.');
  }
  return doc as Document;
}
function collect(doc: Document): Entry[] {
  return Object.entries(doc.paths).flatMap(([path, operations]) => methods.flatMap(method => {
    const op = operations?.[method];
    return op && typeof op.summary === 'string' ? [{
      key: method + ':' + path, path, method, title: op.summary,
      description: op.description ?? '', auth: (op.security ?? []).some(s => 'WalletSession' in s),
      group: groupFor(path)
    }] : [];
  }));
}
export function ApiReference() {
  const [spec, setSpec] = useState<Document>();
  const [runtime, setRuntime] = useState<Runtime>();
  const [statusError, setStatusError] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState('');
  const [section, setSection] = useState('All');
  const [copyState, setCopyState] = useState('');
  const baseUrl = window.location.origin + '/api/v1';
  const fullUrl = (path: string) => window.location.origin + path;
  const openApiUrl = window.location.origin + '/api/v1/openapi.json';
  useEffect(() => {
    const controller = new AbortController();
    setSpec(undefined); setError(''); setLoading(true); setStatusError(false); setRuntime(undefined);
    void (async () => {
      try {
        const response = await fetch('/api/v1/openapi.json', { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error('The API reference is not available. Deploy the matching wallet API and try again.');
        const next = decode(await response.json());
        if (!controller.signal.aborted) setSpec(next);
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load API reference.');
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    void (async () => {
      try {
        const response = await fetch('/health', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw Error('Health status unavailable');
        const value = await response.json() as Runtime;
        if (typeof value.walletDeploymentEnabled !== 'boolean' || typeof value.walletPaymentsEnabled !== 'boolean' || value.network !== 'TESTNET') throw Error('Invalid health response');
        if (!controller.signal.aborted) setRuntime(value);
      } catch { if (!controller.signal.aborted) setStatusError(true); }
    })();
    return () => controller.abort();
  }, [reload]);
  const entries = useMemo(() => spec ? collect(spec) : [], [spec]);
  const shown = useMemo(() => entries.filter(entry =>
    (section === 'All' || entry.group === section) &&
    [entry.method, entry.path, entry.title, entry.description].join(' ').toLowerCase().includes(search.trim().toLowerCase())
  ), [entries, section, search]);
  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setCopyState(label + ' copied.'); }
    catch { setCopyState('Copy unavailable. Select the URL to copy it manually.'); }
  }
  return <div className="developer-portal">
    <div className="heading">
      <div><span className="eyebrow">DEVELOPERS</span><h1>Cherry Wallet API</h1>
        <p>Current API endpoints, request requirements and payment status safeguards for Stellar Testnet.</p></div>
    </div>
    <section className="card developer-intro" aria-label="API connection details">
      <div className="developer-heading"><div><BookOpen size={23}/><h2>Integration reference</h2></div><span className="wallet-pill">Testnet XLM</span></div>
      <p>The API runs on the same origin as the wallet portal. OpenAPI is published by the API itself, so these endpoint listings reflect the running API version—not a copied static list.</p>
      <label htmlFor="developer-api-base">API base URL</label>
      <div className="developer-url"><input id="developer-api-base" value={baseUrl} readOnly/><button type="button" className="secondary-button" onClick={() => void copy(baseUrl, 'API base URL')}><ClipboardCopy size={16}/> Copy</button></div>
      <label htmlFor="developer-openapi-url">OpenAPI 3.1 JSON</label>
      <div className="developer-url"><input id="developer-openapi-url" value={openApiUrl} readOnly/><button type="button" className="secondary-button" onClick={() => void copy(openApiUrl, 'OpenAPI URL')}><ClipboardCopy size={16}/> Copy</button><a className="secondary-button" href="/api/v1/openapi.json" target="_blank" rel="noreferrer"><ExternalLink size={16}/> Open spec</a></div>
      <p role="status">{copyState}</p>
      <div className="developer-tip"><Code2 size={18}/><span>Example: <code>curl -s '{baseUrl}/network'</code></span></div>
      <p><strong>Authentication:</strong> Account APIs require a WebAuthn-backed bearer session. Never put session tokens into URLs or shared documentation. Mutating requests require the configured wallet origin, and payment approvals require a fresh transaction-bound passkey assertion.</p>
    </section>
    <section className="card developer-runtime" aria-label="API runtime status">
      <div className="developer-heading"><h2>Runtime capabilities</h2><button className="secondary-button" type="button" disabled={loading} onClick={() => setReload(v => v + 1)}><RefreshCw size={16}/> Refresh</button></div>
      {runtime ? <div className="developer-metrics">
        <div><span>Network</span><strong>Stellar Testnet</strong></div>
        <div><span>Wallet deployment</span><strong>{runtime.walletDeploymentEnabled ? 'Enabled' : 'Not enabled'}</strong></div>
        <div><span>Wallet payments</span><strong>{runtime.walletPaymentsEnabled ? 'Enabled' : 'Not enabled'}</strong></div>
      </div> : <p role="status">{statusError ? 'Runtime status could not be confirmed. Endpoint documentation is not evidence of enabled payments.' : 'Checking service status…'}</p>}
      <p className="small-copy">A configured API route does not mean on-chain funding, transfer authorization or backup recovery is active. Status is fetched from the same-origin health endpoint.</p>
    </section>
    <section className="card developer-endpoints" aria-label="API endpoint directory">
      <div className="developer-heading"><h2>Endpoint directory</h2>{spec && <span className="wallet-pill">{entries.length} operations</span>}</div>
      <p>Read-only documentation. This page never sends payments, signs requests or uploads credentials.</p>
      <div className="developer-filters">
        <div><label htmlFor="developer-search"><Search size={15}/> Search endpoints</label><input id="developer-search" value={search} type="search" onChange={e => setSearch(e.target.value)} placeholder="Search path, method or purpose…"/></div>
        <div><label htmlFor="developer-group">Category</label><select id="developer-group" value={section} onChange={e => setSection(e.target.value)}><option value="All">All categories</option>{sections.map(value => <option key={value} value={value}>{value}</option>)}</select></div>
      </div>
      {loading && <p role="status">Loading current API contract…</p>}
      {error && <p role="alert">{error} <button className="secondary-button" onClick={() => setReload(v => v + 1)}>Retry</button></p>}
      {spec && <><p role="status">{shown.length} of {entries.length} operations shown · OpenAPI {spec.openapi}</p>
        {sections.filter(group => section === 'All' || section === group).map(group => {
          const list = shown.filter(entry => entry.group === group);
          return list.length ? <section key={group} className="developer-group" aria-label={group}>
            <h3>{group}</h3>{list.map(entry => <details key={entry.key} className="developer-operation">
              <summary><span className={'developer-method method-' + entry.method}>{entry.method.toUpperCase()}</span><span className="developer-path">{entry.path}</span><span className="developer-auth">{entry.auth ? 'Passkey session' : 'Public'}</span></summary>
              <div className="developer-operation-detail"><strong>{entry.title}</strong>{entry.description && <p>{entry.description}</p>}
                <p><strong>Authorization:</strong> {entry.auth ? 'Bearer token issued after WebAuthn authentication; a wallet ID is not authorization.' : 'No bearer session required for this operation.'}</p>
                <p><strong>Endpoint:</strong> <code>{fullUrl(entry.path)}</code></p>
                <button type="button" className="secondary-button" onClick={() => void copy(fullUrl(entry.path), 'Endpoint URL')}><ClipboardCopy size={15}/> Copy endpoint template</button>
              </div>
            </details>)}
          </section> : null;
        })}
        {!shown.length && <p role="status">No endpoints match your filters.</p>}
      </>}
    </section>
    <p className="small-copy">Stellar Testnet XLM has no real-world value. Invoice checkout and settlement are restricted to verified native-XLM events. Aurora mainnet integrations, when separately enabled, are not Testnet funding routes. Developer documentation is not a payment approval interface.</p>
  </div>;
}
