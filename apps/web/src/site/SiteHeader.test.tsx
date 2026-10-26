// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SiteHeader } from './SiteHeader';
import { SiteFooter } from './SiteFooter';

afterEach(cleanup);

it('opens a disclosure with the keyboard and returns focus on Escape', async () => {
  const user = userEvent.setup();
  render(<SiteHeader/>);
  const features = screen.getByRole('button', { name: 'Features' });
  expect(screen.queryByRole('link', { name: /Digital tax records/ })).toBeNull();
  features.focus();
  await user.keyboard('{Enter}{Tab}');
  expect(features.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(screen.getByRole('link', { name: /Digital tax records/ }));
  await user.keyboard('{Escape}');
  expect(features.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(features);
  expect(screen.queryByRole('link', { name: /Digital tax records/ })).toBeNull();
});

it('keeps only one disclosure open and dismisses it when focus leaves', async () => {
  const user = userEvent.setup();
  render(<><SiteHeader/><button>Wallet action</button></>);
  const features = screen.getByRole('button', { name: 'Features' });
  const business = screen.getByRole('button', { name: 'Small Business' });
  await user.click(features);
  await user.click(business);
  expect(features.getAttribute('aria-expanded')).toBe('false');
  expect(business.getAttribute('aria-expanded')).toBe('true');
  await user.click(screen.getByRole('button', { name: 'Wallet action' }));
  expect(business.getAttribute('aria-expanded')).toBe('false');
});

it('dismisses mobile navigation with Escape and returns focus to its toggle', async () => {
  const user = userEvent.setup();
  render(<SiteHeader/>);
  // CSS breakpoint visibility is checked in the browser; the disclosure state
  // and focus order are exercised here independently of viewport emulation.
  const toggle = screen.getByRole('button', { name: 'Open navigation' });
  await user.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  await user.click(screen.getByRole('button', { name: 'Features' }));
  await user.keyboard('{Escape}{Escape}');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(toggle);
});

it('links the shared footer to the public site and keeps contact links intact', () => {
  render(<SiteFooter/>);
  const footer = within(screen.getByRole('contentinfo'));
  expect(footer.getByRole('link', { name: 'Privacy' }).getAttribute('href')).toBe('https://cherrymoney.co.uk/privacy');
  expect(footer.getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('https://cherrymoney.co.uk/term');
  expect(footer.getByRole('link', { name: 'info@cherrymoney.co.uk' }).getAttribute('href')).toBe('mailto:info@cherrymoney.co.uk');
  for (const link of footer.getAllByRole('link')) {
    expect(link.getAttribute('href')).toMatch(/^(https:\/\/|mailto:)/);
  }
});
