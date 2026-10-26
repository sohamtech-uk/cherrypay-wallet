// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { StrKey } from '@stellar/stellar-sdk';
import { Overview } from './Overview';
import { PaymentContext } from './context';
import type { Attempt, PaymentAdapter } from './model';
const address=StrKey.encodeContract(Buffer.alloc(32,1)),other=StrKey.encodeContract(Buffer.alloc(32,2));
const transfer:Attempt={id:'event-1',network:'TESTNET',from:other,destination:address,amountStroops:'10000001',feeStroops:'0',feeKnown:false,createdAt:'2026-10-25T12:00:00.000Z',status:'confirmed',verified:true,transactionHash:'a'.repeat(64)};
function service():PaymentAdapter {return {network:'TESTNET',address,supportedDestinations:['classic'],prepare:vi.fn(),createAttempt:vi.fn(),approve:vi.fn(),getAttempt:vi.fn(),getAttemptByKey:vi.fn(),listAttempts:vi.fn(async()=>({items:[]})),getBalance:vi.fn(async()=>({amountStroops:'9007199254740993',ledger:123,updatedAt:Date.now()})),listTransfers:vi.fn(async()=>({items:[transfer]}))};}
function wrap(adapter:PaymentAdapter|null) {return <MemoryRouter><PaymentContext.Provider value={adapter}><Overview/></PaymentContext.Provider></MemoryRouter>;}
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();sessionStorage.clear();});
it('displays exact indexed amounts and verified receipt links for the owned wallet',async()=>{
  render(wrap(service()));
  expect(await within(screen.getByRole('region',{name:'Connected wallet overview'})).findByText(/900,719,925\.4740993/)).toBeTruthy();
  expect(await screen.findByText('Received 1.0000001 XLM')).toBeTruthy();
  expect(screen.getByRole('link',{name:'Verified Testnet receipt'})).toHaveProperty('href',`https://stellar.expert/explorer/testnet/tx/${'a'.repeat(64)}`);
  expect(screen.queryByText(/Watch a classic/)).toBeNull();
});
it('keeps verified activity available when balance loading fails and supports refresh',async()=>{
  const adapter=service();vi.mocked(adapter.getBalance!).mockRejectedValueOnce(Error('RPC unavailable'));
  render(wrap(adapter));expect((await screen.findByRole('alert')).textContent).toContain('indexed balance');
  expect(screen.getByText('Received 1.0000001 XLM')).toBeTruthy();
  await userEvent.click(screen.getByRole('button',{name:'Refresh overview'}));
  expect(await within(screen.getByRole('region',{name:'Connected wallet overview'})).findByText(/900,719,925\.4740993/)).toBeTruthy();expect(screen.queryByRole('alert')).toBeNull();
});
it('never renders unverified or foreign-wallet events as receipts',async()=>{
  const adapter=service();vi.mocked(adapter.listTransfers!).mockResolvedValue({items:[{...transfer,verified:false}]});
  const view=render(wrap(adapter));await screen.findByRole('alert');expect(screen.queryByRole('link',{name:'Verified Testnet receipt'})).toBeNull();
  const foreign=service();vi.mocked(foreign.listTransfers!).mockResolvedValue({items:[{...transfer,from:other,destination:other}]});
  view.rerender(wrap(foreign));await screen.findByRole('alert');expect(screen.queryByRole('link',{name:'Verified Testnet receipt'})).toBeNull();
});
it('shows missing indexing without inventing a zero balance or transactions',async()=>{
  const adapter=service();vi.mocked(adapter.getBalance!).mockResolvedValue(null);vi.mocked(adapter.listTransfers!).mockResolvedValue({items:[]});
  render(wrap(adapter));await screen.findByText(/Balance awaiting indexing/);expect(screen.getByText('No verified transfers indexed yet.')).toBeTruthy();expect(screen.queryByText('0.0000000 XLM')).toBeNull();
});
it('updates the age warning without requiring a rerender from another screen',async()=>{
  vi.useFakeTimers();const adapter=service();const updatedAt=Date.now();vi.mocked(adapter.getBalance!).mockResolvedValue({amountStroops:'9007199254740993',ledger:123,updatedAt});render(wrap(adapter));await act(async()=>{});
  expect(screen.queryByText(/balance is over a minute old/)).toBeNull();
  await act(async()=>{await vi.advanceTimersByTimeAsync(70000);});
  expect(screen.getByText(/balance is over a minute old/)).toBeTruthy();expect(adapter.getBalance).toHaveBeenCalledTimes(5);
});
it('ignores late reads from a disconnected wallet and clears its data on wallet change',async()=>{
  const first=service();let complete:((value:{amountStroops:string;ledger:number;updatedAt:number})=>void)|undefined;
  first.getBalance=vi.fn(()=>new Promise<Awaited<ReturnType<NonNullable<PaymentAdapter['getBalance']>>>>(resolve=>{complete=resolve;}));
  const view=render(wrap(first));await screen.findByText('Received 1.0000001 XLM');
  const second=service();second.address=other;vi.mocked(second.getBalance!).mockResolvedValue({amountStroops:'20',ledger:124,updatedAt:Date.now()});vi.mocked(second.listTransfers!).mockResolvedValue({items:[]});
  view.rerender(wrap(second));await within(screen.getByRole('region',{name:'Connected wallet overview'})).findByText(/0\.000002/);
  await act(async()=>{complete!({amountStroops:'99999999',ledger:123,updatedAt:Date.now()});});
  expect(screen.queryByText(/9\.9999999/)).toBeNull();expect(screen.queryByText('Received 1.0000001 XLM')).toBeNull();
  view.rerender(wrap(null));expect(screen.queryByText(/0\.000002/)).toBeNull();expect(screen.getByText('Connect your passkey profile')).toBeTruthy();
});
it('keeps watch-only lookup separate, validates checksums and preserves decimal precision',async()=>{
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({balances:[{asset_type:'native',balance:'900719925.4740993'}]})));vi.stubGlobal('fetch',fetcher);
  const user=userEvent.setup();render(wrap(null));await user.click(screen.getByText('Watch a classic Testnet account'));
  const input=screen.getByLabelText('Classic Testnet account address');
  await user.type(input,'G'+'A'.repeat(55));await user.click(screen.getByRole('button',{name:'View account'}));await screen.findByRole('alert');expect(fetcher).not.toHaveBeenCalled();
  await user.clear(input);await user.type(input,StrKey.encodeEd25519PublicKey(Buffer.alloc(32,1)));await user.click(screen.getByRole('button',{name:'View account'}));
  expect(await screen.findByText('900719925.4740993 XLM · watch-only')).toBeTruthy();
  expect(screen.queryByRole('link',{name:'Send XLM'})).toBeNull();
});
