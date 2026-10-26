import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, Menu, X } from 'lucide-react';

const menuId = (label: string) => label.toLowerCase().replace(/[^a-z]/g, '-');

export function HeaderMenu() {
  const [open, setOpen] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const nav = useRef<HTMLElement>(null);
  const location = useLocation();
  useEffect(() => { setOpen(null); setMobile(false); }, [location.pathname]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!nav.current?.contains(event.target as Node)) { setOpen(null); setMobile(false); } };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return <nav className="header-navigation" ref={nav} aria-label="Cherry Pay services" onKeyDown={event => { if (event.key === 'Escape') { const id = open; setOpen(null); setMobile(false); document.getElementById(`header-${id ? menuId(id) : 'toggle'}`)?.focus(); } }}>
    <button id="header-toggle" className="header-mobile-toggle" aria-label="Open services navigation" aria-expanded={mobile} aria-controls="header-services" onClick={() => setMobile(!mobile)}>{mobile ? <X size={20}/> : <Menu size={20}/>}</button>
    <div id="header-services" className={`header-services ${mobile ? 'is-open' : ''}`}>
      {['Products', 'Buy & Sell', 'Connect', 'Downloads'].map(label => <div className="header-menu" key={label}>
        <button id={`header-${menuId(label)}`} aria-expanded={open === label} aria-controls={`panel-${menuId(label)}`} onClick={() => setOpen(open === label ? null : label)}>{label}<ChevronDown size={13}/></button>
        {open === label && <div className="header-menu-panel" id={`panel-${menuId(label)}`}>
          {label === 'Products' && <><Link to="/">Cherry Pay Wallet<small>Personal Testnet payments</small></Link><a href="https://cherrymoney.co.uk/" target="_blank" rel="noreferrer">Cherry Money ↗</a><a href="https://tax.cherrymoney.co.uk/" target="_blank" rel="noreferrer">Cherry Tax ↗</a><Link to="/business">Business dashboard<small>Invoices and payment runs</small></Link><Link to="/payroll">Payroll<small>Review and approve payment runs</small></Link><Link to="/upgrade">Cherry Pay Upgrade<small>Explore plans and future benefits</small></Link></>}
          {label === 'Buy & Sell' && <><Link to="/profile">Fund Testnet wallet<small>One-time 10,000 Testnet XLM allocation</small></Link><p>Buying and selling real crypto is not available in this Testnet wallet.</p></>}
          {label === 'Connect' && <><a href="https://cherrymoney.co.uk/help" target="_blank" rel="noreferrer">Help & support ↗</a><Link to="/security">Security & recovery</Link><Link to="/access-history">Access history</Link><a href="https://github.com/sohamtech-uk/cherrypay-wallet" target="_blank" rel="noreferrer">GitHub ↗</a></>}
          {label === 'Downloads' && <><Link to="/history">Export payment activity<small>Download the current page as CSV</small></Link><p>Cherry Pay runs in your browser. Native apps and a browser extension are not available yet.</p></>}
        </div>}
      </div>)}
    </div>
  </nav>;
}
