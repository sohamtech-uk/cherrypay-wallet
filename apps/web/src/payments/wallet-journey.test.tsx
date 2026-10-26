// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { StrKey } from '@stellar/stellar-sdk';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import App from '../App';

vi.mock('@simplewebauthn/browser',()=>({startAuthentication:vi.fn(),startRegistration:vi.fn()}));
const address=StrKey.encodeContract(Buffer.alloc(32,5));
const wallet={id:address,address,network:'TESTNET',supportedDestinations:['contract'],approvalMode:'webauthn'};
const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200});
function stubBackend(mode:'register'|'authenticate'='authenticate',owned=true){
  const calls=vi.fn(async (url:string)=>{
    if(url.endsWith('/passkeys/onboarding/options'))
      return json({mode,accountID:'alice@example.com',requestID:'challenge',options:{challenge:'challenge'}});
    if(url.endsWith('/passkeys/authentication/verify') || url.endsWith('/passkeys/registration/verify'))
      return json({verified:true,accountID:'alice@example.com',token:'private-session',expiresInSeconds:1800,credentialCount:1});
    if(url.endsWith('/session/logout'))return new Response(null,{status:204});
    if(url.endsWith('/wallets'))return json({network:'TESTNET',items:owned?[wallet]:[]});
    if(url.endsWith('/smart-account/deployment'))return new Response(JSON.stringify({
      status:'PENDING',address:null,transactionHash:null,deploymentEnabled:false,
      nextAction:'PASSKEY_CONTROLLED_DEPLOYMENT_NOT_YET_CONFIGURED'}),{status:202});
    if(url.endsWith('/balance'))return json({network:'TESTNET',address,snapshot:null});
    if(url.endsWith('/transfers') || url.endsWith('/attempts'))return json({network:'TESTNET',items:[]});
    return json(wallet);
  });
  vi.stubGlobal('fetch',calls);
  return calls;
}
beforeEach(()=>{
  localStorage.clear();
  vi.mocked(startAuthentication).mockResolvedValue({id:'credential'} as Awaited<ReturnType<typeof startAuthentication>>);
  vi.mocked(startRegistration).mockResolvedValue({id:'new-credential'} as Awaited<ReturnType<typeof startRegistration>>);
});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.unstubAllGlobals();vi.restoreAllMocks();});

it('completes returning-user sign-in, keeps one session through dashboard/profile navigation and signs out',async()=>{
  const calls=stubBackend();
  const user=userEvent.setup();
  render(<MemoryRouter initialEntries={['/']}><App/></MemoryRouter>);
  expect(screen.getByRole('heading',{name:'Welcome to Cherry Wallet'})).toBeTruthy();
  expect(screen.queryByRole('checkbox',{name:'Use a legacy account ID'})).toBeNull();
  await user.type(screen.getByLabelText('Email address (Account ID)'),'alice@example.com');
  await user.click(screen.getByRole('button',{name:'Continue with email'}));
  expect(await screen.findByRole('heading',{name:'Home'})).toBeTruthy();
  await user.click(screen.getAllByRole('link',{name:'Profile & settings'})[0]);
  expect(await screen.findByLabelText('Email address / Account ID')).toHaveProperty('value','alice@example.com');
  expect(screen.queryByLabelText('Payment service connection')).toBeNull();
  expect(screen.getByLabelText('Wallet address')).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Show address'}));
  expect(screen.getByLabelText('Wallet address')).toHaveProperty('value',address);
  await user.click(screen.getByRole('link',{name:'Dashboard'}));
  expect(screen.getByRole('heading',{name:'Home'})).toBeTruthy();
  await user.click(screen.getAllByRole('link',{name:'Profile & settings'})[0]);
  expect(screen.getByLabelText('Email address / Account ID')).toHaveProperty('value','alice@example.com');
  expect(calls.mock.calls.filter(([url])=>url.endsWith('/passkeys/onboarding/options'))).toHaveLength(1);
  await user.click(screen.getByRole('button',{name:'Sign out'}));
  expect(await screen.findByRole('heading',{name:'Sign in to your account'})).toBeTruthy();
  expect(screen.queryByLabelText('Wallet address')).toBeNull();
  await waitFor(()=>expect(calls.mock.calls.some(([url])=>url.endsWith('/session/logout'))).toBe(true));
  expect(localStorage.getItem('private-session')).toBeNull();
});

it('registers a new email with a passkey and shows wallet deployment unavailable without claiming readiness',async()=>{
  const calls=stubBackend('register',false);
  const user=userEvent.setup();
  render(<MemoryRouter initialEntries={['/']}><App/></MemoryRouter>);
  await user.type(screen.getByLabelText('Email address (Account ID)'),'alice@example.com');
  await user.click(screen.getByRole('button',{name:'Continue with email'}));
  expect(await screen.findByText(/Automatic wallet creation is disabled on this server/)).toBeTruthy();
  expect(screen.getByText('✓ Passkey verified')).toBeTruthy();
  expect(screen.getByText('Wallet deployment unavailable')).toBeTruthy();
  expect(screen.queryByText('Wallet connected.')).toBeNull();
  await user.click(screen.getAllByRole('link',{name:'Profile & settings'})[0]);
  expect(screen.getByLabelText('Email address / Account ID')).toHaveProperty('value','alice@example.com');
  expect(screen.queryByLabelText('Wallet address')).toBeNull();
  expect(calls.mock.calls.filter(([url])=>url.endsWith('/passkeys/registration/verify'))).toHaveLength(1);
});
