// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentConnection } from './Connection';
import { StrKey } from '@stellar/stellar-sdk';
import { startAuthentication } from '@simplewebauthn/browser';
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn(async () => ({ id: 'credential' })) }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const address=StrKey.encodeContract(Buffer.alloc(32,1));
const other=StrKey.encodeContract(Buffer.alloc(32,2));
const row={id:'wallet-1',address,network:'TESTNET'};
const response=(value:unknown)=>new Response(JSON.stringify(value),{status:200});
function fixture(items:unknown[]=[row],seconds=1800) {
  const fetcher=vi.fn(async(url:string)=>{
    if(url.endsWith('/options'))return response({requestID:'challenge',options:{challenge:'challenge'}});
    if(url.endsWith('/verify'))return response({verified:true,accountID:'account-1',token:'secret-session',expiresInSeconds:seconds});
    if(url.endsWith('/wallets'))return response({network:'TESTNET',items});
    if(url.endsWith('/balance'))return response({network:'TESTNET',address:url.includes('wallet-2')?other:address,snapshot:null});
    if(url.endsWith('/logout'))return new Response(null,{status:204});
    return response({...row,id:url.endsWith('wallet-2')?'wallet-2':row.id,address:url.endsWith('wallet-2')?other:address,supportedDestinations:['classic']});
  });
  vi.stubGlobal('fetch',fetcher);return fetcher;
}
async function signIn(user:ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Account ID'),'account-1');
  await user.click(screen.getByRole('button',{name:'Connect with passkey'}));
}
it('discovers the owned wallet after passkey login without asking for a wallet ID or storing its token',async()=>{
  const fetcher=fixture(), local=vi.spyOn(Storage.prototype,'setItem'),onConnect=vi.fn();
  const user=userEvent.setup();render(<PaymentConnection onConnect={onConnect}/>);
  expect(screen.queryByLabelText('Deployed wallet ID')).toBeNull();
  await signIn(user);await screen.findByText(/Wallet connected/);
  expect(startAuthentication).toHaveBeenCalledWith({optionsJSON:{challenge:'challenge'}});
  expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({address,canSign:false}));expect(local).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledWith('/api/v1/wallets',expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer secret-session'})}));
  await user.click(screen.getByRole('button',{name:'Disconnect wallet'}));
  await screen.findByRole('button',{name:'Connect with passkey'});expect(onConnect).toHaveBeenLastCalledWith(null);
  expect(fetcher).toHaveBeenCalledWith('/api/v1/session/logout',expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer secret-session'})}));
});
it('requires a selection when multiple owned wallets exist and opens only that wallet',async()=>{
  fixture([row,{id:'wallet-2',address:other,network:'TESTNET'}]);const onConnect=vi.fn(),user=userEvent.setup();render(<PaymentConnection onConnect={onConnect}/>);
  await signIn(user);const select=await screen.findByLabelText('Choose your wallet');expect(onConnect).not.toHaveBeenCalled();
  await user.selectOptions(select,'wallet-2');await user.click(screen.getByRole('button',{name:'Open wallet'}));
  await screen.findByText(/Wallet connected/);expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({address:other}));
});
it('shows an explicit setup state for an account without deployed wallets',async()=>{
  fixture([]);const onConnect=vi.fn(),user=userEvent.setup();render(<PaymentConnection onConnect={onConnect}/>);
  await signIn(user);await screen.findByText(/No deployed wallet is linked/);expect(onConnect).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'Disconnect wallet'})).toBeTruthy();
});
it('does not connect or discover wallets when passkey verification fails',async()=>{
  const fetcher=vi.fn(async(url:string)=>new Response(JSON.stringify(url.endsWith('/options')?{requestID:'challenge',options:{}}:{error:'denied'}),{status:url.endsWith('/options')?200:400}));vi.stubGlobal('fetch',fetcher);
  const onConnect=vi.fn(),user=userEvent.setup();render(<PaymentConnection onConnect={onConnect}/>);
  await signIn(user);await screen.findByRole('alert');expect(onConnect).toHaveBeenCalledWith(null);expect(fetcher.mock.calls.some(([url])=>url.endsWith('/wallets'))).toBe(false);
});
it('revokes the session if discovery returns malformed or foreign-network data',async()=>{
  fixture([{...row,network:'PUBLIC'}]);const onConnect=vi.fn(),user=userEvent.setup();render(<PaymentConnection onConnect={onConnect}/>);
  await signIn(user);await screen.findByRole('alert');expect(onConnect).toHaveBeenCalledWith(null);expect(screen.queryByText(/Wallet connected/)).toBeNull();
});
it('does not resurrect a session when wallet metadata arrives after expiry',async()=>{
  vi.useFakeTimers();const fetcher=fixture([row],1),original=fetcher.getMockImplementation()!;
  let complete:((value:Response)=>void)|undefined;
  fetcher.mockImplementation(url=>url.endsWith('/wallets/wallet-1')?new Promise(resolve=>{complete=resolve;}):original(url));
  const onConnect=vi.fn();render(<PaymentConnection onConnect={onConnect}/>);
  fireEvent.change(screen.getByLabelText('Account ID'),{target:{value:'account-1'}});
  await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:'Connect with passkey'}).closest('form')!);});
  expect(complete).toBeDefined();
  await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});
  expect(screen.getByRole('alert').textContent).toContain('session expired');
  await act(async()=>{complete!(response({...row,supportedDestinations:['classic']}));});
  expect(onConnect.mock.calls.every(([value])=>value===null)).toBe(true);expect(screen.queryByText(/Wallet connected/)).toBeNull();
});
