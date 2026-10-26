import { useEffect, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';
import './site.css';
import { industries } from './industries';

// Shared public-site design and links from cherrymoney.co.uk. Wallet navigation
// and payment/session state stay in the wallet shell below this component.
export function SiteHeader() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const headerRef = useRef<HTMLElement>(null);
  const mobileButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!mobileOpen && !openMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !headerRef.current?.contains(event.target)) {
        setMobileOpen(false);
        setOpenMenu(null);
      }
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [mobileOpen, openMenu]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape') return;
    if (openMenu) {
      headerRef.current?.querySelector<HTMLButtonElement>(`#${openMenu}-trigger`)?.focus();
      setOpenMenu(null);
    } else if (mobileOpen) {
      setMobileOpen(false);
      mobileButtonRef.current?.focus();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function handleBlur(event: FocusEvent<HTMLElement>) {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
      setMobileOpen(false);
      setOpenMenu(null);
    }
  }

  return <>
    <div className="cb-promo"><a href="https://cherrymoney.co.uk/making-tax-digital">Making Tax Digital: prepare your digital records from £0 →</a></div>
    <header ref={headerRef} className={`cb-header${mobileOpen ? " is-open" : ""}`} onKeyDown={handleKeyDown} onBlur={handleBlur}>
      <a className="cb-brand" href="https://cherrymoney.co.uk/" aria-label="Cherry Money home"><img src="/brand/cherrymoney-logo.png" alt="Cherry Money" width="489" height="321"/></a>
      <button className="cb-menu-button" type="button" aria-controls="cb-navigation cb-header-actions" ref={mobileButtonRef} aria-label={mobileOpen ? "Close navigation" : "Open navigation"} aria-expanded={mobileOpen} onClick={() => { setMobileOpen(!mobileOpen); setOpenMenu(null); }}>
        <span aria-hidden="true"/>
        <span aria-hidden="true"/>
        <span aria-hidden="true"/>
      </button>
      <nav className="cb-nav" id="cb-navigation" aria-label="Main navigation">
        <a href="https://cherrymoney.co.uk/pricing">Pricing</a>
        <div className={`cb-nav-item${openMenu === 'features-menu' ? ' is-open' : ''}`} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpenMenu(current => current === 'features-menu' ? null : current); }}>
          <button className="cb-nav-trigger" type="button" aria-controls="features-menu" id="features-menu-trigger" aria-expanded={openMenu === 'features-menu'} onClick={() => setOpenMenu(current => current === 'features-menu' ? null : 'features-menu')}>
            Features
            <span aria-hidden="true">⌄</span>
          </button>
          <div className="cb-mega-menu cb-features-menu" id="features-menu" hidden={openMenu !== 'features-menu'} aria-labelledby="features-menu-trigger">
            <div className="cb-mega-main">
              <p className="cb-menu-label">Popular features</p>
              <div className="cb-feature-menu-grid">
                <a href="https://cherrymoney.co.uk/products/sole-trader">
                  <span className="cb-menu-icon" aria-hidden="true">1</span>
                  <div>
                    <strong>Sole Trader</strong>
                    <small>Digital tax records and invoicing for self-employed work.</small>
                  </div>
                </a>
                <a href="https://cherrymoney.co.uk/products/accounting">
                  <span className="cb-menu-icon" aria-hidden="true">▤</span>
                  <div>
                    <strong>Accounting</strong>
                    <small>Connected finance for small and growing businesses.</small>
                  </div>
                </a>
                <a href="https://cherrymoney.co.uk/products/payroll">
                  <span className="cb-menu-icon" aria-hidden="true">£</span>
                  <div>
                    <strong>Payroll</strong>
                    <small>PAYE, pensions, RTI and payroll workflows.</small>
                  </div>
                </a>
                <a href="https://cherrymoney.co.uk/products/accountants">
                  <span className="cb-menu-icon" aria-hidden="true">◎</span>
                  <div>
                    <strong>Accountants</strong>
                    <small>Practice workflows and client portfolio tools.</small>
                  </div>
                </a>
                <a href="https://cherrymoney.co.uk/#platform">
                  <span className="cb-menu-icon" aria-hidden="true">▤</span>
                  <div>
                    <strong>Accounting workspace</strong>
                    <small>Run daily finance in one clear place.</small>
                  </div>
                </a>
                <a href="https://cherrymoney.co.uk/#products">
                  <span className="cb-menu-icon" aria-hidden="true">↗</span>
                  <div>
                    <strong>Invoices &amp; quotes</strong>
                    <small>Create, send and follow up faster.</small>
                  </div>
                </a>
                <a href="https://cherrymoney.co.uk/#score">
                  <span className="cb-menu-icon" aria-hidden="true">◎</span>
                  <div>
                    <strong>Money Score</strong>
                    <small>See financial health at a glance.</small>
                  </div>
                </a>
                <a href="https://cherrymoney.co.uk/making-tax-digital">
                  <span className="cb-menu-icon" aria-hidden="true">£</span>
                  <div>
                    <strong>VAT &amp; MTD</strong>
                    <small>Prepare and maintain your digital records.</small>
                  </div>
                </a>
                <a href="https://cherrymoney.co.uk/#agents">
                  <span className="cb-menu-icon" aria-hidden="true">AI</span>
                  <div>
                    <strong>Cherry AI agents</strong>
                    <small>Turn signals into practical actions.</small>
                  </div>
                </a>
                <a href="https://cherrymoney.co.uk/ask-cherry">
                  <span className="cb-menu-icon" aria-hidden="true">AI</span>
                  <div>
                    <strong>Ask Cherry</strong>
                    <small>Ask finance questions and prepare reviewable next steps.</small>
                  </div>
                </a>
                <a href="https://cherrymoney.co.uk/#integrations">
                  <span className="cb-menu-icon" aria-hidden="true">+</span>
                  <div>
                    <strong>App integrations</strong>
                    <small>Explore 100+ marketplace listings.</small>
                  </div>
                </a>
              </div>
            </div>
            <aside className="cb-mega-aside">
              <p className="cb-menu-label">More to explore</p>
              <a href="https://cherrymoney.co.uk/free-tools">
                Free business tools
                <span>→</span>
              </a>
              <a href="https://cherrymoney.co.uk/#solutions">
                Solutions by need
                <span>→</span>
              </a>
              <a href="https://cherrymoney.co.uk/pricing">
                Compare all plans
                <span>→</span>
              </a>
              <div className="cb-menu-promo">
                <strong>Finance answers, when you need them</strong>
                <p>Try Ask Cherry for invoices, VAT and cash-flow decisions.</p>
                <a className="cb-button cb-button-primary" href="https://cherrymoney.co.uk/ask-cherry">Try Ask Cherry</a>
              </div>
            </aside>
          </div>
        </div>
        <div className={`cb-nav-item${openMenu === 'small-business-menu' ? ' is-open' : ''}`} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpenMenu(current => current === 'small-business-menu' ? null : current); }}>
          <button className="cb-nav-trigger" type="button" aria-controls="small-business-menu" id="small-business-menu-trigger" aria-expanded={openMenu === 'small-business-menu'} onClick={() => setOpenMenu(current => current === 'small-business-menu' ? null : 'small-business-menu')}>
            Small Business
            <span aria-hidden="true">⌄</span>
          </button>
          <div className="cb-mega-menu cb-small-business-menu" id="small-business-menu" hidden={openMenu !== 'small-business-menu'} aria-labelledby="small-business-menu-trigger">
            <div className="cb-mega-main">
              <p className="cb-menu-label">Finance by industry</p>
              <div className="cb-industry-menu-grid">
                {industries.map(industry => <a key={industry.slug} href={`https://cherrymoney.co.uk/small-businesses/${industry.slug}`}>
                  <span className="cb-menu-icon" aria-hidden="true">{industry.label.charAt(0)}</span>
                  <div><strong>{industry.label}</strong><small>{industry.description}</small></div>
                </a>)}
              </div>
            </div>
            <aside className="cb-mega-aside">
              <p className="cb-menu-label">Small Business</p>
              <a href="https://cherrymoney.co.uk/small-businesses">
                Explore all industries
                <span>→</span>
              </a>
              <a href="https://cherrymoney.co.uk/products/sole-trader">
                Sole Trader software
                <span>→</span>
              </a>
              <a href="https://cherrymoney.co.uk/products/accounting">
                Accounting software
                <span>→</span>
              </a>
              <a href="https://cherrymoney.co.uk/products/payroll">
                Payroll software
                <span>→</span>
              </a>
              <div className="cb-menu-promo cb-small-business-menu-promo">
                <strong>Not sure which route fits?</strong>
                <p>Use the pricing finder to choose by business type and size.</p>
                <a className="cb-button cb-button-primary" href="https://cherrymoney.co.uk/pricing">Find a plan</a>
              </div>
            </aside>
          </div>
        </div>
        <a className="cb-nav-priority" href="https://cherrymoney.co.uk/making-tax-digital">Making Tax Digital</a>
        <div className={`cb-nav-item${openMenu === 'business-services-menu' ? ' is-open' : ''}`} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpenMenu(current => current === 'business-services-menu' ? null : current); }}>
          <button className="cb-nav-trigger" type="button" aria-controls="business-services-menu" id="business-services-menu-trigger" aria-expanded={openMenu === 'business-services-menu'} onClick={() => setOpenMenu(current => current === 'business-services-menu' ? null : 'business-services-menu')}>
            Business services
            <span aria-hidden="true">⌄</span>
          </button>
          <div className="cb-mega-menu" id="business-services-menu" hidden={openMenu !== 'business-services-menu'} aria-labelledby="business-services-menu-trigger">
            <div className="cb-mega-main">
              <p className="cb-menu-label">Start, manage and grow</p>
              <div className="cb-feature-menu-grid">
                <a href="https://cherrymoney.co.uk/business-services#start">
                  <strong>Start a business</strong>
                </a>
                <a href="https://cherrymoney.co.uk/business-services#company">
                  <strong>Update your company</strong>
                </a>
                <a href="https://cherrymoney.co.uk/business-services#tax">
                  <strong>Tax registrations &amp; filings</strong>
                </a>
                <a href="https://cherrymoney.co.uk/business-services#close">
                  <strong>Pause or close</strong>
                </a>
                <a href="https://cherrymoney.co.uk/business-services#address">
                  <strong>London address services</strong>
                </a>
                <a href="https://cherrymoney.co.uk/business-services/orders">
                  <strong>My service requests</strong>
                </a>
              </div>
            </div>
          </div>
        </div>
        <a href="https://cherrymoney.co.uk/en-gb/blog">Blog</a>
        <div className={`cb-nav-item${openMenu === 'accountants-menu' ? ' is-open' : ''}`} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpenMenu(current => current === 'accountants-menu' ? null : current); }}>
          <button className="cb-nav-trigger" type="button" aria-controls="accountants-menu" id="accountants-menu-trigger" aria-expanded={openMenu === 'accountants-menu'} onClick={() => setOpenMenu(current => current === 'accountants-menu' ? null : 'accountants-menu')}>
            Accountants
            <span aria-hidden="true">⌄</span>
          </button>
          <div className="cb-mega-menu cb-partner-menu" id="accountants-menu" hidden={openMenu !== 'accountants-menu'} aria-labelledby="accountants-menu-trigger">
            <div className="cb-partner-menu-copy">
              <p className="cb-menu-label">For accountants &amp; bookkeepers</p>
              <h2>A clearer practice view, with clients and compliance connected.</h2>
              <p>Bring review work, client records, VAT, payroll, reporting and AI-assisted next steps into one connected finance workflow.</p>
              <a className="cb-button cb-button-primary" href="https://cherrymoney.co.uk/products/accountants">Explore Accountants</a>
            </div>
            <div className="cb-partner-menu-links">
              <p className="cb-menu-label">Accountants</p>
              <a href="https://cherrymoney.co.uk/products/accountants">
                <span className="cb-menu-icon" aria-hidden="true">◎</span>
                <div>
                  <strong>Accountants overview</strong>
                  <small>Practice workflows, client review and controls.</small>
                </div>
              </a>
              <a href="https://cherrymoney.co.uk/products/accountants#pricing">
                <span className="cb-menu-icon" aria-hidden="true">£</span>
                <div>
                  <strong>Workspace pricing</strong>
                  <small>See current accountant workspace pricing.</small>
                </div>
              </a>
              <a href="https://cherrymoney.co.uk/pricing">
                <span className="cb-menu-icon" aria-hidden="true">▤</span>
                <div>
                  <strong>Plans for clients</strong>
                  <small>Sole Trader, Accounting and Payroll options.</small>
                </div>
              </a>
              <a href="https://cherrymoney.co.uk/partner">
                <span className="cb-menu-icon" aria-hidden="true">↗</span>
                <div>
                  <strong>Partner programme</strong>
                  <small>Onboarding, learning and practice support.</small>
                </div>
              </a>
              <a href="https://cherrymoney.co.uk/partner/sign-up">
                <span className="cb-menu-icon" aria-hidden="true">✓</span>
                <div>
                  <strong>Become a partner</strong>
                  <small>Apply to join the CherryMoney partner programme.</small>
                </div>
              </a>
              <a href="https://cherrymoney.co.uk/legal/partner-agreement">
                <span className="cb-menu-icon" aria-hidden="true">≡</span>
                <div>
                  <strong>Partner agreement</strong>
                  <small>Review programme terms and responsibilities.</small>
                </div>
              </a>
            </div>
          </div>
        </div>
        <a href="https://cherrymoney.co.uk/help">Support</a>
      </nav>
      <div className="cb-header-actions" id="cb-header-actions">
        <a className="cb-link" href="https://cherrymoney.co.uk/login">Log in</a>
        <a className="cb-button cb-button-dark" href="https://cherrymoney.co.uk/signup">Open account</a>
      </div>
    </header>
  </>;
}
