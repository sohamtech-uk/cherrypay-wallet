import { useEffect, useRef } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, BriefcaseBusiness, Clock3, LayoutDashboard, ReceiptText, Settings2, Wallet } from 'lucide-react';

const navigation = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/send', label: 'Send', icon: ArrowUpRight },
  { to: '/receive', label: 'Receive', icon: ArrowDownLeft },
  { to: '/history', label: 'Activity', icon: Clock3 },
  { to: '/business', label: 'Business', icon: BriefcaseBusiness },
];

export function WalletShell({ children, externalNetwork }: { children: React.ReactNode; externalNetwork?: 'TESTNET' | 'MAINNET' }) {
  const { pathname } = useLocation();
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Route changes remain in the same authenticated session; move keyboard focus to the new screen.
    const heading = content.current?.querySelector('h1');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }, [pathname]);
  const mainnet = pathname === '/pay-from-another-chain' && externalNetwork === 'MAINNET';
  const readOnly = pathname === '/recipient-intelligence';
  return <div className="wallet-site wallet-workspace">
    <a className="skip-link" href="#wallet-content">Skip to content</a>
    <header className="workspace-header">
      <Link to="/" className="brand" aria-label="Cherry Wallet home"><span className="brand-icon"><Wallet size={21}/></span><span>Cherry<span className="brand-accent">Wallet</span></span></Link>
      <div className="workspace-tools"><span className={mainnet ? 'mainnet-tag' : readOnly ? 'read-only-tag' : 'testnet'}>{mainnet ? 'Mainnet · real USDC' : readOnly ? 'Read only' : 'Stellar Testnet'}</span><Link className="settings-link" to="/profile" aria-label="Profile & settings"><Settings2 size={19}/><span>Settings</span></Link></div>
    </header>
    <div className="app">
      <aside className="sidebar">
        <nav aria-label="Wallet navigation">{navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => isActive ? 'active' : ''}><Icon size={19}/><span>{label}</span></NavLink>)}
          <NavLink className="desktop-nav" to="/invoices"><ReceiptText size={19}/><span>Invoices</span></NavLink>
        </nav>
        <div className="sidebar-bottom"><a href="https://cherrymoney.co.uk/" target="_blank" rel="noreferrer">Part of Cherry Money ↗</a><Link to="/security">Security & recovery</Link><Link to="/developers">API documentation</Link></div>
      </aside>
      <main className="main" id="wallet-content" tabIndex={-1}>
        <div className="content" ref={content}>{children}</div>
        <footer className="workspace-footer"><span>{mainnet ? 'Real USDC · Base to Stellar mainnet' : readOnly ? 'Recipient checks never approve a payment.' : 'Testnet XLM has no real-world value.'}</span><Link to="/developers">API reference</Link><a href="https://cherrymoney.co.uk/help" target="_blank" rel="noreferrer">Help</a><a href="https://cherrymoney.co.uk/privacy" target="_blank" rel="noreferrer">Privacy</a></footer>
      </main>
    </div>
  </div>;
}
