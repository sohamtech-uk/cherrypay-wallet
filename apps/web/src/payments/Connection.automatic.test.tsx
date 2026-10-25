// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrKey } from '@stellar/stellar-sdk';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { PaymentConnection } from './Connection';
import { parseDeployment } from './deployment';

vi.mock('@simplewebauthn/browser',()=>({startAuthentication:vi.fn(),startRegistration:vi.fn()}));
beforeEach(()=>{
  vi.clearAllMocks();localStorage.clear();
  vi.mocked(startAuthentication).mockResolvedValue({id:'primary'} as Awaited<ReturnType<typeof startAuthentication>>);
  vi.mocked(startRegistration).mockResolvedValue({id:'primary'} as Awaited<ReturnType<typeof startRegistration>>);
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
const address=StrKey.encodeContract(Buffer.alloc(32,19));
const pending={network:'TESTNET',status:'PENDING',deploymentEnabled:true,address:null,transactionHash:null,onChainSignerBound:false,recoveryReady:false,spendingEnabled:false};
const confirmed={...pending,status:'CONFIRMED',address,transactionHash:'a'.repeat(64),confirmedLedger:300,primaryRuleId:0,primaryCredentialId:'primary',onChainSignerBound:true};
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function fixture(read:()=>Promise<Response>=async()=>response(confirmed),discoveryCode=503) {
  const fetcher=vi.fn(async(url:string,options?:RequestInit)=>{
    if(url.endsWith('/options'))return response({accountID:'account-1',requestID:'challenge',options:{challenge:'challenge'}});
    if(url.endsWith('/verify'))return response({verified:true,accountID:'account-1',token:'verified-session',expiresInSeconds:1800,credentialCount:1});
    if(url.endsWith('/wallets'))return response({error:discoveryCode===503?'PAYMENT_INTEGRATION_NOT_CONFIGURED':'AUTHENTICATION_REQUIRED'},discoveryCode);
    if(url.endsWith('/smart-account/deployment'))return options?.method==='POST'?response(pending,202):read();
    if(url.endsWith('/logout'))return new Response(null,{status:204});
    throw Error('Unexpected endpoint');
  });
  vi.stubGlobal('fetch',fetcher);return fetcher;
}
async function loginWithTimers() {
  fireEvent.change(screen.getByLabelText('Account ID'),{target:{value:'account-1'}});
  await act(async()=>{fireEvent.submit(screen.getByRole('button',{name:'Connect with passkey'}).closest('form')!);});
}
it('automatically confirms a primary C-address while payments remain disabled, without making a payment adapter',async()=>{
  vi.useFakeTimers();const fetcher=fixture(),onConnect=vi.fn();render(<PaymentConnection onConnect={onConnect}/>);
  await loginWithTimers();
  expect(screen.getByText(/Provisioning status: PENDING/)).toBeTruthy();
  expect(screen.queryByLabelText('Deployed C-address')).toBeNull();
  await act(async()=>{await vi.advanceTimersByTimeAsync(5001);});
  expect(screen.getByLabelText('Deployed C-address')).toHaveProperty('value',address);
  expect(screen.getByText(/primary passkey signer binding is verified/)).toBeTruthy();
  expect(screen.getByText(/Payments and funding instructions remain unavailable/)).toBeTruthy();
  expect(screen.getByRole('link',{name:'View deployment transaction'}).getAttribute('href')).toBe('https://stellar.expert/explorer/testnet/tx/'+'a'.repeat(64));
  expect(onConnect).not.toHaveBeenCalled();
  const jobs=fetcher.mock.calls.filter(([url])=>url.endsWith('/smart-account/deployment'));
  expect(jobs.map(([,options])=>options?.method)).toEqual(['POST','GET']);
  await act(async()=>{await vi.advanceTimersByTimeAsync(10000);});
  expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/smart-account/deployment'))).toHaveLength(2);
});
it('ignores a late confirmed address after disconnect during a polling request',async()=>{
  vi.useFakeTimers();let complete:((result:Response)=>void)|undefined;
  fixture(()=>new Promise(resolve=>{complete=resolve;}));const onConnect=vi.fn();render(<PaymentConnection onConnect={onConnect}/>);
  await loginWithTimers();await act(async()=>{await vi.advanceTimersByTimeAsync(5001);});
  expect(complete).toBeDefined();
  await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Disconnect wallet'}));});
  await act(async()=>{complete!(response(confirmed));});
  expect(screen.queryByLabelText('Deployed C-address')).toBeNull();expect(onConnect).toHaveBeenLastCalledWith(null);
  expect(screen.queryByText(/signer binding is verified/)).toBeNull();
});
it('does not reinterpret an authentication failure as an empty wallet list',async()=>{
  const fetcher=fixture(undefined,401),user=userEvent.setup();render(<PaymentConnection onConnect={vi.fn()}/>);
  await user.type(screen.getByLabelText('Account ID'),'account-1');await user.click(screen.getByRole('button',{name:'Connect with passkey'}));
  await screen.findByRole('alert');
  expect(fetcher.mock.calls.some(([url])=>url.endsWith('/smart-account/deployment'))).toBe(false);
  expect(screen.queryByText(/1 passkey enrolled/)).toBeNull();
});
it('retains the profile but rejects a claimed C-address without verified primary binding',async()=>{
  vi.useFakeTimers();fixture(async()=>response({...confirmed,onChainSignerBound:false}));render(<PaymentConnection onConnect={vi.fn()}/>);
  await loginWithTimers();await act(async()=>{await vi.advanceTimersByTimeAsync(5001);});
  expect(screen.getByRole('alert').textContent).toContain('profile remains connected');
  expect(screen.queryByLabelText('Deployed C-address')).toBeNull();expect(screen.getByText(/1 passkey enrolled/)).toBeTruthy();
});
it.each([
  {network:'PUBLIC'}, {address:'G'+'A'.repeat(55)}, {onChainSignerBound:false}, {confirmedLedger:0},
  {primaryRuleId:1}, {spendingEnabled:true}, {recoveryReady:true}, {transactionHash:'untrusted/link'}, {status:'ACTIVE'},
])('rejects invalid confirmed deployment evidence: %j',changes=>{
  expect(()=>parseDeployment({...confirmed,...changes})).toThrow();
});
it('does not expose a predicted address from pending or disabled deployment responses',()=>{
  expect(parseDeployment(pending)).toEqual({status:'PENDING',enabled:true,transactionHash:undefined});
  expect(()=>parseDeployment({...pending,address})).toThrow();
  expect(parseDeployment({status:'PENDING',deploymentEnabled:false,address})).toEqual({status:'PENDING',enabled:false});
});
