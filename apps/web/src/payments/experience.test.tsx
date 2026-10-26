// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { WalletShell } from '../WalletShell';
import { UpgradeBanner } from '../Upgrade';
import { MarketChart } from './MarketChart';
import { AccessHistory } from './AccessHistory';
import { WalletAccountContext, type WalletAccount } from './account-context';
import type { AccessPage } from './access-api';

afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();localStorage.clear();});
it('offers Cherry links, payroll and an upgrade preview without charging or requiring login',async()=>{
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);const user=userEvent.setup();
  render(<MemoryRouter initialEntries={['/upgrade']}><App/></MemoryRouter>);
  expect(screen.getByRole('heading',{name:'A wallet that grows with you.'})).toBeTruthy();
  expect(within(screen.getByRole('navigation',{name:'Wallet navigation'})).getByRole('link',{name:'Payroll'}).getAttribute('href')).toBe('/payroll');
  expect(screen.getAllByText('Plan preview')).toHaveLength(2);expect(screen.getByText(/No payment is collected/)).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Products'}));
  const services=within(screen.getByRole('navigation',{name:'Cherry Pay services'}));
  expect(services.getByRole('link',{name:'Cherry Tax ↗'}).getAttribute('href')).toBe('https://tax.cherrymoney.co.uk/');
  await user.keyboard('{Escape}');expect(screen.queryByRole('link',{name:'Cherry Tax ↗'})).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button',{name:'Products'}));expect(fetcher).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toMatch(/LOBSTR/i);expect(document.body.textContent).toContain('Stellar');
  expect(within(screen.getByRole('banner')).getByRole('link',{name:'Built on Stellar'}).getAttribute('href')).toBe('https://stellar.org/');
  expect(within(screen.getByRole('banner')).getByText('Stellar Testnet')).toBeTruthy();
});
it('keeps upgrade navigation available after dismissing the banner',async()=>{
  const user=userEvent.setup();render(<MemoryRouter><WalletShell><UpgradeBanner/></WalletShell></MemoryRouter>);
  await user.click(screen.getByRole('button',{name:'Dismiss upgrade banner'}));expect(screen.queryByRole('region',{name:'Cherry Pay upgrades'})).toBeNull();expect(screen.getByRole('link',{name:'Upgrade'})).toBeTruthy();
});
it('renders actual market data separately from test funds and clears it when another period fails',async()=>{
  const now=Date.now(),fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({prices:[[now-86400000,.1],[now,.2]],updatedAt:now,days:1,currency:'USD',asset:'XLM',source:'CoinGecko'}))).mockResolvedValueOnce(new Response('{}',{status:503}));vi.stubGlobal('fetch',fetcher);
  const user=userEvent.setup();render(<MarketChart/>);expect(await screen.findByRole('img',{name:/XLM price in USD/})).toBeTruthy();expect(screen.getByText(/Testnet XLM has no monetary value/)).toBeTruthy();
  expect(screen.getByText('Sampled high · 24 hours')).toBeTruthy();
  expect(screen.getByRole('slider',{name:'Explore price history'}).getAttribute('aria-valuetext')).toContain('0.2000 USD');
  await user.click(screen.getByRole('button',{name:'1W'}));expect(await screen.findByText('Market data is unavailable')).toBeTruthy();expect(screen.queryByRole('img')).toBeNull();
});
it('announces loading without claiming an outage, and lets keyboard users explore real price points',async()=>{
  let resolve!:(response:Response)=>void;
  vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(done=>{resolve=done;})));
  const now=Date.now();const user=userEvent.setup();render(<MarketChart/>);
  expect(screen.getByRole('heading',{name:'Loading XLM price…'})).toBeTruthy();
  expect(screen.queryByText('Price unavailable')).toBeNull();
  resolve(new Response(JSON.stringify({prices:[[now-86400000,.1],[now-3600000,.3],[now,.2]],updatedAt:now,days:1,currency:'USD',asset:'XLM',source:'CoinGecko'})));
  const slider=await screen.findByRole('slider',{name:'Explore price history'});
  expect(slider.getAttribute('aria-valuetext')).toContain('0.2000 USD');
  await user.click(slider);
  // jsdom does not implement native range-arrow behaviour; dispatch the same input change.
  const {fireEvent}=await import('@testing-library/react');
  fireEvent.change(slider,{target:{value:'1'}});
  expect(slider.getAttribute('aria-valuetext')).toContain('0.3000 USD');
  expect(screen.getByRole('link',{name:'CoinGecko ↗'}).getAttribute('href')).toBe('https://www.coingecko.com/en/coins/stellar');
});
it('requires explicit map loading and revocation confirmation; hides history after logout',async()=>{
  const id='a'.repeat(8)+'-aaaa-aaaa-aaaa-'+'a'.repeat(12),createdAt=new Date().toISOString();
  const page:AccessPage={items:[{id,createdAt,expiresAt:new Date(Date.now()+1800000).toISOString(),ip:'192.0.2.1',userAgent:'Chrome/120 Mac',current:true,active:true,location:{latitude:51.5,longitude:-.1,source:'browser'}}],truncated:false,mapsBrowserKey:'public-key'};
  const account:WalletAccount={accountId:'alice@example.test',authenticated:true,connected:true,credentialCount:1,canSign:true,busy:false,error:'',notice:'',deployment:null,deploymentStatus:'',wallets:[],addPasskey:vi.fn(),refreshDeployment:vi.fn(),fundTestnet:vi.fn(),signOut:vi.fn(),listAccess:vi.fn(async()=>page),revokeAccess:vi.fn(),shareLocation:vi.fn()};
  const user=userEvent.setup(),view=render(<MemoryRouter><WalletAccountContext.Provider value={account}><AccessHistory/></WalletAccountContext.Provider></MemoryRouter>);
  await screen.findByText('Chrome · macOS');expect(document.querySelector('iframe')).toBeNull();
  await user.click(screen.getByRole('button',{name:'View location'}));expect(document.querySelector('iframe')).toBeNull();
  await user.click(screen.getByRole('button',{name:'Load Google Map'}));expect(document.querySelector('iframe')?.src).toContain('center=51.5,-0.1');
  await user.click(screen.getByRole('button',{name:'Sign out here'}));expect(account.revokeAccess).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button',{name:'Confirm sign out'}));expect(account.revokeAccess).toHaveBeenCalledWith(id);expect(account.signOut).toHaveBeenCalledOnce();
  view.rerender(<MemoryRouter><WalletAccountContext.Provider value={{...account,authenticated:false}}><AccessHistory/></WalletAccountContext.Provider></MemoryRouter>);expect(screen.queryByText('Chrome · macOS')).toBeNull();expect(document.querySelector('iframe')).toBeNull();
});
