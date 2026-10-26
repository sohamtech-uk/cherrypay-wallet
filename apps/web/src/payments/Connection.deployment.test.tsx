// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { PaymentConnection } from './Connection';

vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn(), startRegistration: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  vi.mocked(startAuthentication).mockResolvedValue({ id: 'credential' } as Awaited<ReturnType<typeof startAuthentication>>);
  vi.mocked(startRegistration).mockResolvedValue({ id: 'new-credential' } as Awaited<ReturnType<typeof startRegistration>>);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const pending = () => response({ status: 'PENDING', address: null, transactionHash: null, deploymentEnabled: false }, 202);
function fixture(deployment: (init?: RequestInit) => Promise<Response>, seconds = 1800, mode = 'authenticate') {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/options')) return response({ mode, accountID: 'alice@example.com', requestID: 'challenge', options: { challenge: 'challenge' } });
    if (url.endsWith('/verify')) return response({ verified: true, accountID: 'alice@example.com', token: 'secret-session', expiresInSeconds: seconds, credentialCount: 1 });
    if (url.endsWith('/wallets')) return response({ network: 'TESTNET', items: [] });
    if (url.endsWith('/smart-account/deployment')) return deployment(init);
    if (url.endsWith('/logout')) return new Response(null, { status: 204 });
    throw Error('Unexpected test endpoint');
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email address (Account ID)'), 'alice@example.com');
  await user.click(screen.getByRole('button', { name: 'Continue with email' }));
}

it.each(['unavailable', 'missing-status', 'unknown-status', 'unexpected-enablement'])('keeps a verified profile connected when deployment status is %s', async failure => {
  const fetcher = fixture(async () => {
    if (failure === 'unavailable') return response({ error: 'PRIVATE_DATABASE_DETAIL' }, 503);
    if (failure === 'missing-status') return response({ deploymentEnabled: false });
    if (failure === 'unknown-status') return response({ status: 'ARBITRARY_UNTRUSTED_VALUE', deploymentEnabled: false });
    return response({ status: 'ACTIVE', deploymentEnabled: true });
  });
  const onConnect = vi.fn(), user = userEvent.setup();
  render(<PaymentConnection onConnect={onConnect}/>);
  await signIn(user);
  expect((await screen.findByRole('alert')).textContent).toContain('Your passkey profile remains connected');
  expect(screen.getByText(/1 passkey enrolled/)).toBeTruthy();
  expect(screen.getByText(/Provisioning status: UNAVAILABLE/)).toBeTruthy();
  expect(screen.getByText(/Deployment status has not been verified/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add another passkey' })).toHaveProperty('disabled', false);
  expect(onConnect).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/logout'))).toBe(false);
  expect(screen.queryByText(/PRIVATE_DATABASE_DETAIL|ARBITRARY_UNTRUSTED_VALUE/)).toBeNull();
});

it('keeps a newly enrolled profile usable when the reservation request times out', async () => {
  const fetcher = fixture(async () => { throw Error('Network timeout'); },1800,'register');
  const user = userEvent.setup(); render(<PaymentConnection onConnect={vi.fn()}/>);
  await user.type(screen.getByLabelText('Email address (Account ID)'), 'alice@example.com');
  await user.click(screen.getByRole('button', { name: 'Continue with email' }));
  await screen.findByRole('alert');
  expect(screen.getByText(/1 passkey enrolled/)).toBeTruthy();
  expect(localStorage.getItem('cherrypay:testnet:account-id')).toBe('alice@example.com');
  expect(startRegistration).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/registration/verify'))).toHaveLength(1);
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/logout'))).toBe(false);
});

it('ignores a pending deployment response after disconnect', async () => {
  let complete: ((value: Response) => void) | undefined;
  fixture(() => new Promise(resolve => { complete = resolve; }));
  const onConnect = vi.fn(), user = userEvent.setup(); render(<PaymentConnection onConnect={onConnect}/>);
  await signIn(user);
  expect(complete).toBeDefined();
  await user.click(screen.getByRole('button', { name: 'Sign out and disconnect wallet' }));
  await act(async () => { complete!(pending()); });
  expect(screen.getByRole('button', { name: 'Continue with email' })).toBeTruthy();
  expect(screen.queryByText(/Provisioning status/)).toBeNull();
  expect(screen.queryByText(/1 passkey enrolled/)).toBeNull();
  expect(onConnect.mock.calls.every(([value]) => value === null)).toBe(true);
});

it('ignores deployment responses after the authenticated session expires', async () => {
  vi.useFakeTimers();
  let complete: ((value: Response) => void) | undefined;
  fixture(() => new Promise(resolve => { complete = resolve; }), 1);
  const onConnect = vi.fn(); render(<PaymentConnection onConnect={onConnect}/>);
  fireEvent.change(screen.getByLabelText('Email address (Account ID)'), { target: { value: 'alice@example.com' } });
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Continue with email' }).closest('form')!); });
  expect(complete).toBeDefined();
  await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
  expect(screen.getByRole('alert').textContent).toContain('session expired');
  await act(async () => { complete!(pending()); });
  expect(screen.queryByText(/Provisioning status/)).toBeNull();
  expect(screen.queryByText(/1 passkey enrolled/)).toBeNull();
  expect(onConnect.mock.calls.every(([value]) => value === null)).toBe(true);
});

it('offers funding only after verified deployment and replaces the prompt with a verified allocation receipt',async()=>{
  const {StrKey}=await import('@stellar/stellar-sdk');
  let funding:Record<string,unknown>={status:'AVAILABLE',amountStroops:'100000000000'};
  const deployed=()=>response({status:'CONFIRMED',network:'TESTNET',deploymentEnabled:true,spendingEnabled:false,recoveryReady:false,onChainSignerBound:true,address:StrKey.encodeContract(Buffer.alloc(32,1)),transactionHash:'a'.repeat(64),confirmedLedger:200,primaryRuleId:0,primaryCredentialId:'primary',funding});
  const fetcher=fixture(async()=>deployed()),original=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async url=>{
    if(url.endsWith('/smart-account/funding')){funding={...funding,status:'SUBMITTED'};return response(funding,202);}return original(url);
  });
  const user=userEvent.setup();render(<PaymentConnection onConnect={vi.fn()}/>);await signIn(user);
  await screen.findByText(/one-time allocation of 10,000 Testnet XLM/);
  expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/smart-account/funding'))).toHaveLength(0);
  await user.click(await screen.findByRole('button',{name:'Fund Testnet wallet'}));
  await screen.findByText(/allocation is pending confirmation/);
  expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/smart-account/funding'))).toHaveLength(1);
  expect(screen.queryByRole('button',{name:'Fund Testnet wallet'})).toBeNull();
  funding={...funding,status:'FUNDED',ledger:201,transactionHash:'b'.repeat(64)};
  await user.click(screen.getByRole('button',{name:'Refresh deployment status'}));
  await screen.findByText(/10,000 Testnet XLM allocated/);
  expect(screen.getByRole('link',{name:'View funding transaction'}).getAttribute('href')).toContain('b'.repeat(64));
});
it('shows an unresolved grant without a second funding button',async()=>{
  const {StrKey}=await import('@stellar/stellar-sdk');
  fixture(async()=>response({status:'CONFIRMED',network:'TESTNET',deploymentEnabled:true,spendingEnabled:false,recoveryReady:false,
    onChainSignerBound:true,address:StrKey.encodeContract(Buffer.alloc(32,1)),transactionHash:'a'.repeat(64),confirmedLedger:200,
    primaryRuleId:0,primaryCredentialId:'primary',funding:{status:'REVIEW_REQUIRED',amountStroops:'100000000000'}}));
  const user=userEvent.setup();render(<PaymentConnection onConnect={vi.fn()}/>);await signIn(user);
  await screen.findByText(/Funding confirmation needs operator review/);
  expect(screen.queryByRole('button',{name:'Fund Testnet wallet'})).toBeNull();
  expect(screen.queryByText(/XLM allocated/)).toBeNull();
});
it('never creates a new passkey when an existing user cancels authentication',async()=>{
  fixture(async()=>pending());vi.mocked(startAuthentication).mockRejectedValueOnce(new DOMException('Cancelled','NotAllowedError'));
  const user=userEvent.setup();render(<PaymentConnection onConnect={vi.fn()}/>);await signIn(user);
  await screen.findByRole('alert');expect(startRegistration).not.toHaveBeenCalled();
});

it.each(['AWAITING_PASSKEY', 'PENDING', 'NOT_STARTED'])('resumes a %s reservation after the operator enables deployment without another passkey ceremony', async status => {
  let enabled = false;
  const fetcher = fixture(async () => response(enabled
    ? { status: 'PENDING', network: 'TESTNET', deploymentEnabled: true, onChainSignerBound: false, spendingEnabled: false, recoveryReady: false }
    : { status, deploymentEnabled: false }, 202));
  const user = userEvent.setup();
  render(<PaymentConnection onConnect={vi.fn()}/>);
  await signIn(user);
  await screen.findByText(/Automatic wallet creation is disabled on this server/);
  expect(screen.queryByText(/Provisioning status: AWAITING_PASSKEY/)).toBeNull();
  expect(startAuthentication).toHaveBeenCalledTimes(1);
  enabled = true;
  await user.click(screen.getByRole('button', { name: 'Refresh deployment status' }));
  await screen.findByText(/Automatic Testnet deployment is processing/);
  const reservations = fetcher.mock.calls.filter(([url]) => url.endsWith('/smart-account/deployment'));
  expect(reservations).toHaveLength(2);
  expect(reservations[1][1]).toMatchObject({ method: 'POST', body: '{}' });
  expect(startAuthentication).toHaveBeenCalledTimes(1);
  expect(startRegistration).not.toHaveBeenCalled();
});

it('opens a newly confirmed primary wallet automatically without another login ceremony',async()=>{
  const {StrKey}=await import('@stellar/stellar-sdk'),address=StrKey.encodeContract(Buffer.alloc(32,1));
  let confirmed=false;
  const row={id:address,address,network:'TESTNET'};
  const fetcher=fixture(async()=>response(confirmed?{
    status:'CONFIRMED',network:'TESTNET',deploymentEnabled:true,spendingEnabled:true,walletId:address,recoveryReady:false,
    onChainSignerBound:true,address,transactionHash:'a'.repeat(64),confirmedLedger:200,primaryRuleId:0,primaryCredentialId:'primary',
    funding:{status:'FUNDED',amountStroops:'100000000000',transactionHash:'b'.repeat(64),ledger:201}
  }:{status:'PENDING',network:'TESTNET',deploymentEnabled:true,spendingEnabled:false,recoveryReady:false,onChainSignerBound:false}));
  const original=fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async(url,init)=>{
    if(url.endsWith('/wallets'))return response({network:'TESTNET',items:confirmed?[row]:[]});
    if(url.endsWith('/wallets/'+address))return response({...row,supportedDestinations:['classic','contract'],approvalMode:'webauthn',receive:{address,route:'contract',instructions:'Receive Testnet XLM through the native SAC.'}});
    if(url.endsWith('/balance'))return response({network:'TESTNET',address,snapshot:{amountStroops:'100000000000',ledger:201}});
    return original(url,init);
  });
  const onConnect=vi.fn(),user=userEvent.setup();render(<PaymentConnection onConnect={onConnect}/>);await signIn(user);
  await screen.findByText(/Automatic Testnet deployment is processing/);expect(onConnect).not.toHaveBeenCalled();
  confirmed=true;await user.click(screen.getByRole('button',{name:'Refresh deployment status'}));
  await screen.findByText('Wallet connected.');await screen.findByText(/10,000 Testnet XLM allocated/);
  expect(onConnect).toHaveBeenCalledTimes(1);expect(onConnect).toHaveBeenCalledWith(expect.objectContaining({address,canSign:true,supportedDestinations:['classic','contract']}));
  expect(startAuthentication).toHaveBeenCalledTimes(1);expect(startRegistration).not.toHaveBeenCalled();
});
it('refuses payment activation if the verified C-address is absent from owned discovery',async()=>{
  const {StrKey}=await import('@stellar/stellar-sdk'),address=StrKey.encodeContract(Buffer.alloc(32,1));
  fixture(async()=>response({status:'CONFIRMED',network:'TESTNET',deploymentEnabled:true,spendingEnabled:true,walletId:address,recoveryReady:false,onChainSignerBound:true,address,transactionHash:'a'.repeat(64),confirmedLedger:200,primaryRuleId:0,primaryCredentialId:'primary'}));
  const onConnect=vi.fn(),user=userEvent.setup();render(<PaymentConnection onConnect={onConnect}/>);await signIn(user);
  await screen.findByRole('alert');expect(onConnect).not.toHaveBeenCalled();expect(screen.getByText(/1 passkey enrolled/)).toBeTruthy();
});
