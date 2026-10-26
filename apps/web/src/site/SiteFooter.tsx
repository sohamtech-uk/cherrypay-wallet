// Keep these public-site destinations on cherrymoney.co.uk, including deep wallet routes.
export function SiteFooter() {
  return (
    <footer className="cb-footer">
      <div className="cb-footer-grid">
        <div className="cb-footer-brand-block">
          <a className="cb-brand cb-brand-footer" href="https://cherrymoney.co.uk/" aria-label="Cherry Money home"><img src="/brand/cherrymoney-logo.png" alt="Cherry Money" loading="lazy" decoding="async" width="489" height="321"/></a>
          <p>Accounting, tax, payroll, payments and AI-guided finance for growing businesses.</p>
          <div role="group" className="cb-footer-contact" aria-label="Contact Cherry Money">
            <a href="mailto:info@cherrymoney.co.uk">info@cherrymoney.co.uk</a>
            <a href="https://www.wa.me/447868296813" target="_blank" rel="noreferrer">+44 7868 296813</a>
          </div>
        </div>
        <nav className="cb-footer-column" aria-label="Products">
          <h2>Products</h2>
          <a href="https://cherrymoney.co.uk/products/sole-trader">Sole Trader</a>
          <a href="https://cherrymoney.co.uk/products/accounting">Accounting</a>
          <a href="https://cherrymoney.co.uk/products/payroll">Payroll</a>
          <a href="https://cherrymoney.co.uk/products/accountants">Accountants</a>
          <a href="https://cherrymoney.co.uk/ask-cherry">Ask Cherry</a>
          <a href="https://cherrymoney.co.uk/making-tax-digital">Making Tax Digital</a>
        </nav>
        <nav className="cb-footer-column" aria-label="Solutions and resources">
          <h2>Solutions</h2>
          <a href="https://cherrymoney.co.uk/business-services">Company formation &amp; filings</a>
          <a href="https://cherrymoney.co.uk/business-services/orders">My service requests</a>
          <a href="https://cherrymoney.co.uk/small-businesses">Small Businesses</a>
          <a href="https://cherrymoney.co.uk/partner">Partners</a>
          <a href="https://cherrymoney.co.uk/pricing">Pricing</a>
          <a href="https://cherrymoney.co.uk/#integrations">Integrations</a>
          <h2 className="cb-footer-subheading">Resources</h2>
          <a href="https://cherrymoney.co.uk/en-gb/blog">Blog</a>
          <a href="https://cherrymoney.co.uk/help">Help Centre</a>
          <a href="https://cherrymoney.co.uk/free-tools">Free Tools</a>
        </nav>
        <nav className="cb-footer-column cb-footer-comparisons" aria-label="Compare Cherry Money">
          <h2>Compare Cherry Money</h2>
          <a href="https://cherrymoney.co.uk/compare/xero">Cherry Money vs Xero</a>
          <a href="https://cherrymoney.co.uk/compare/sage">Cherry Money vs Sage</a>
          <a href="https://cherrymoney.co.uk/compare/quickbooks">Cherry Money vs QuickBooks</a>
          <a href="https://cherrymoney.co.uk/compare/freeagent">Cherry Money vs FreeAgent</a>
          <a href="https://cherrymoney.co.uk/compare/zoho-books">Cherry Money vs Zoho Books</a>
          <a href="https://cherrymoney.co.uk/compare/freshbooks">Cherry Money vs FreshBooks</a>
          <a className="cb-footer-view-all" href="https://cherrymoney.co.uk/compare">View all comparisons →</a>
        </nav>
        <nav className="cb-footer-column" aria-label="Company and support">
          <h2>Company &amp; Support</h2>
          <a href="https://cherrymoney.co.uk/#contact-us">Contact</a>
          <a href="https://cherrymoney.co.uk/partner">Partner Programme</a>
          <a href="https://cherrymoney.co.uk/help">Support</a>
          <a href="https://cherrymoney.co.uk/privacy">Privacy</a>
          <a href="https://cherrymoney.co.uk/term">Terms</a>
        </nav>
      </div>
      <div className="cb-footer-bottom">
        <p>© {new Date().getFullYear()} Cherry Money. All rights reserved.</p>
        <p>Cherry Money is independent and is not affiliated with Xero, Sage, Intuit QuickBooks, FreeAgent, Zoho or FreshBooks. Product names and trademarks belong to their respective owners.</p>
      </div>
    </footer>
  );
}
