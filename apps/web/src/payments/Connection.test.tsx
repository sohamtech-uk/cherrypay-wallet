// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaymentConnection } from './Connection';
import { StrKey } from '@stellar/stellar-sdk';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn(), startRegistration: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); vi.mocked(startAuthentication).mockResolvedValue({ id: 'credential' } as Awaited<ReturnType<typeof startAuthentication>>); vi.mocked(startRegistration).mockResolvedValue({ id: 'new-credential' } as Awaited<ReturnType<typeof startRegistration>>); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const address=StrKey.encodeContract(Buffer.alloc(32,1));
const other=StrKey.encodeContract(Buffer.alloc(32,2));
const row={id:'wallet-1',address,network:'TESTNET'};
const response=(value:unknown)=>new Response(JSON.stringify(value),{status:200});
function fixture(items:unknown[]=[row],seconds=1800) {
  const fetcher=vi.fn(async(url:string)=>{
    if(url.endsWith('/options'))return response({accountID:'account-1',requestID:'challenge',options:{challenge:'challenge'}});
    if(url.endsWith('/verify'))return response({verified:true,accountID:'account-1',token:'secret-session',expiresInSeconds:seconds,credentialCount:1});
    if(url.endsWith('/wallets'))return response({network:'TESTNET',items});
    if(url.endsWith('/smart-account/deployment'))return new Response(JSON.stringify({status:'PENDING',address:null,transactionHash:null,deploymentEnabled:false,nextAction:'PASSKEY_CONTROLLED_DEPLOYMENT_NOT_YET_CONFIGURED'}),{status:202});
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
  expect(fetcher.mock.calls.some(([url])=>url.endsWith('/smart-account/deployment'))).toBe(false);
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
  const fetcher=fixture([]);const onConnect=vi.fn(),user=userEvent.setup();render(<PaymentConnection onConnect={onConnect}/>);
  await signIn(user);await screen.findByText(/No deployed wallet is linked/);expect(onConnect).not.toHaveBeenCalled();
  expect(screen.getByText(/Provisioning status: PENDING/)).toBeTruthy();
  expect(screen.getByText(/On-chain deployment is not enabled yet/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetcher).toHaveBeenCalledWith('/api/v1/smart-account/deployment',expect.objectContaining({method:'POST',body:'{}',headers:expect.objectContaining({Authorization:'Bearer secret-session'})}));
  expect(screen.getByRole('button',{name:'Disconnect wallet'})).toBeTruthy();
});
it('does not connect or discover wallets when passkey verification fails',async()=>{
  const fetcher=vi.fn(async(url:string)=>new Response(JSON.stringify(url.endsWith('/options')?{accountID:'account-1',requestID:'challenge',options:{}}:{error:'denied'}),{status:url.endsWith('/options')?200:400}));vi.stubGlobal('fetch',fetcher);
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

it('creates a profile once, saves only its public ID before the ceremony and discovers linked wallets',async()=>{
  const fetcher=fixture([]), storage=vi.spyOn(Storage.prototype,'setItem');
  vi.mocked(startRegistration).mockImplementation(async()=>{
    expect(localStorage.getItem('cherrypay:testnet:account-id')).toBe('account-1');
    return {id:'new-credential'} as Awaited<ReturnType<typeof startRegistration>>;
  });
  const user=userEvent.setup();render(<PaymentConnection onConnect={vi.fn()}/>);
  await user.dblClick(screen.getByRole('button',{name:'Create passkey profile'}));
  await screen.findByText(/1 passkey enrolled/);
  expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/registration/verify'))).toHaveLength(1);
  expect(storage.mock.calls).toEqual([['cherrypay:testnet:account-id','account-1']]);
  expect(screen.getByLabelText('Account ID')).toHaveProperty('value','account-1');
  expect(screen.getByText(/No deployed wallet is linked/)).toBeTruthy();
});
it('keeps the account ID after an interrupted initial verification so sign-in can recover it',async()=>{
  const fetcher=fixture([]),original=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(url=>{if(url.endsWith('/registration/verify'))throw Error('Network unavailable');return original(url);});
  const user=userEvent.setup(),view=render(<PaymentConnection onConnect={vi.fn()}/>);
  await user.click(screen.getByRole('button',{name:'Create passkey profile'}));
  expect((await screen.findByRole('alert')).textContent).toContain('reconnect with this account ID');
  view.unmount();render(<PaymentConnection onConnect={vi.fn()}/>);
  expect(screen.getByLabelText('Account ID')).toHaveProperty('value','account-1');
  await user.click(screen.getByRole('button',{name:'Connect with passkey'}));
  await screen.findByText(/1 passkey enrolled/);
  expect(startRegistration).toHaveBeenCalledTimes(1);
});
it('handles cancellation before initial verification without losing the public account ID',async()=>{
  const fetcher=fixture([]);
  vi.mocked(startRegistration).mockRejectedValueOnce(new DOMException('Passkey request cancelled.','NotAllowedError'));
  const user=userEvent.setup();render(<PaymentConnection onConnect={vi.fn()}/>);
  await user.click(screen.getByRole('button',{name:'Create passkey profile'}));
  await screen.findByRole('alert');
  expect(fetcher.mock.calls.some(([url])=>url.endsWith('/registration/verify'))).toBe(false);
  expect(localStorage.getItem('cherrypay:testnet:account-id')).toBe('account-1');
  expect(screen.getByRole('button',{name:'Create passkey profile'})).toHaveProperty('disabled',false);
});
it('binds additional enrollment to the current session, replaces it and revokes the old token',async()=>{
  const fetcher=fixture(),original=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(url=>url.endsWith('/registration/verify')?Promise.resolve(response({verified:true,accountID:'account-1',token:'replacement-session',expiresInSeconds:1800,credentialCount:2})):original(url));
  const user=userEvent.setup(),onConnect=vi.fn();render(<PaymentConnection onConnect={onConnect}/>);
  await signIn(user);await screen.findByText(/Wallet connected/);
  await user.click(screen.getByRole('button',{name:'Add another passkey'}));
  await screen.findByText(/2 passkeys enrolled/);
  for(const endpoint of ['registration/options','registration/verify','session/logout']) {
    expect(fetcher).toHaveBeenCalledWith(`/api/v1/${endpoint.startsWith('session')?'':'passkeys/'}${endpoint}`,expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer secret-session'})}));
  }
  expect(fetcher).toHaveBeenLastCalledWith('/api/v1/wallets/wallet-1',expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer replacement-session'})}));
  expect(onConnect.mock.calls.some(([value])=>value===null)).toBe(true);
  expect(screen.getByText(/does not change your wallet’s on-chain signers/)).toBeTruthy();
});
it('keeps a usable session when the user cancels additional enrollment before verification',async()=>{
  const fetcher=fixture();vi.mocked(startRegistration).mockRejectedValueOnce(new DOMException('Cancelled by user','NotAllowedError'));
  const user=userEvent.setup();render(<PaymentConnection onConnect={vi.fn()}/>);
  await signIn(user);await screen.findByText(/Wallet connected/);
  await user.click(screen.getByRole('button',{name:'Add another passkey'}));await screen.findByRole('alert');
  expect(screen.getByText(/Wallet connected/)).toBeTruthy();
  expect(fetcher.mock.calls.some(([url])=>url.endsWith('/logout')||url.endsWith('/registration/verify'))).toBe(false);
});
it('revokes a late new session instead of reconnecting after disconnect during enrollment',async()=>{
  const fetcher=fixture(),original=fetcher.getMockImplementation()!;
  let complete:((value:Response)=>void)|undefined;
  fetcher.mockImplementation(url=>url.endsWith('/registration/verify')?new Promise(resolve=>{complete=resolve;}):original(url));
  const user=userEvent.setup(),onConnect=vi.fn();render(<PaymentConnection onConnect={onConnect}/>);
  await signIn(user);await screen.findByText(/Wallet connected/);
  await user.click(screen.getByRole('button',{name:'Add another passkey'}));expect(complete).toBeDefined();
  await user.click(screen.getByRole('button',{name:'Disconnect wallet'}));
  await act(async()=>{complete!(response({verified:true,accountID:'account-1',token:'abandoned-session',expiresInSeconds:1800,credentialCount:2}));});
  expect(fetcher).toHaveBeenCalledWith('/api/v1/session/logout',expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer abandoned-session'})}));
  expect(onConnect).toHaveBeenLastCalledWith(null);expect(screen.queryByText(/Wallet connected/)).toBeNull();
});
it('keeps a selectable ID and manual recovery instructions when browser storage and clipboard fail',async()=>{
  const user=userEvent.setup();fixture([]);
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('Storage unavailable');});
  vi.spyOn(navigator.clipboard,'writeText').mockRejectedValueOnce(Error('Denied'));
  render(<PaymentConnection onConnect={vi.fn()}/>);
  await user.click(screen.getByRole('button',{name:'Create passkey profile'}));
  await screen.findByText(/This browser cannot save your account ID/);
  await user.click(screen.getByRole('button',{name:'Copy account ID'}));
  expect((await screen.findByRole('alert')).textContent).toContain('copy it manually');
  expect(screen.getByLabelText('Account ID')).toHaveProperty('value','account-1');
});
it('revokes an invalid returned session without attempting wallet discovery',async()=>{
  const fetcher=fixture([]),original=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(url=>url.endsWith('/verify')?Promise.resolve(response({verified:true,accountID:'different-owner',token:'invalid-session',expiresInSeconds:1800,credentialCount:1})):original(url));
  const user=userEvent.setup();render(<PaymentConnection onConnect={vi.fn()}/>);
  await signIn(user);await screen.findByRole('alert');
  expect(fetcher).toHaveBeenCalledWith('/api/v1/session/logout',expect.objectContaining({headers:expect.objectContaining({Authorization:'Bearer invalid-session'})}));
  expect(fetcher.mock.calls.some(([url])=>url.endsWith('/wallets'))).toBe(false);
});
