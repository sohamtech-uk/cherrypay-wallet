import { Component, useEffect, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <section className="card payment-screen" role="alert"><h1>Unable to display this screen</h1><p>Your payment may still be processing. Open history to check an existing attempt before starting another payment.</p><Link className="secondary-button" to="/history">Check transaction history</Link><button onClick={() => this.setState({ failed: false })}>Try loading again</button></section> : this.props.children;
  }
}
export function Recovery({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  useEffect(() => { const heading = document.querySelector('h1'); if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); } }, [pathname]);
  return <ScreenBoundary key={pathname}>{children}</ScreenBoundary>;
}
