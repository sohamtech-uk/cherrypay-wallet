// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { StrKey } from '@stellar/stellar-sdk';
import { Profile } from './Profile';
import { WalletAccountContext, type WalletAccount } from './account-context';
import { PaymentContext } from './context';
import type { PaymentAdapter } from './model';

const address = StrKey.encodeContract(Buffer.alloc(32, 4));
const actions = { addPasskey: vi.fn(async () => {}), refreshDeployment: vi.fn(async () => {}), fundTestnet: vi.fn(async () => {}), signOut: vi.fn(async () => {}) };
function account(override: Partial<WalletAccount> = {}): WalletAccount {
  return {accountId:'alice@example.com', authenticated:true, connected:true, credentialCount:1, canSign:true, busy:false,
    error:'',notice:'',deployment:null,deploymentStatus:'CONFIRMED',wallets:[],...actions,...override};
}
function adapter(): PaymentAdapter {
  return {network:'TESTNET',address,supportedDestinations:['contract'],
    prepare:vi.fn(),createAttempt:vi.fn(),approve:vi.fn(),getAttempt:vi.fn(),getAttemptByKey:vi.fn(),listAttempts:vi.fn()};
}
function mount(state: WalletAccount | null, service: PaymentAdapter | null) {
  return render(<MemoryRouter><PaymentContext.Provider value={service}>
    <WalletAccountContext.Provider value={state}><Profile/></WalletAccountContext.Provider>
  </PaymentContext.Provider></MemoryRouter>);
}
afterEach(()=>{cleanup();vi.clearAllMocks();vi.restoreAllMocks();});

it('requires authentication before displaying account identity, wallet address or actions',()=>{
  mount(null, null);
  expect(screen.getByText('Sign in to your account')).toBeTruthy();
  expect(screen.queryByLabelText('Email address / Account ID')).toBeNull();
  expect(screen.queryByRole('button',{name:'Add another passkey'})).toBeNull();
});

it('separates authenticated profile information from the wallet sign-in panel',()=>{
  mount(account(),adapter());
  expect(screen.getByLabelText('Email address / Account ID')).toHaveProperty('value','alice@example.com');
  expect(screen.getByText('1 passkey registered for sign-in.')).toBeTruthy();
  expect(screen.getByText(/Email and an additional sign-in passkey alone cannot restore it/)).toBeTruthy();
  expect(screen.queryByLabelText('Payment service connection')).toBeNull();
});

it('hides the verified address until requested and copies only the full unmasked address',async()=>{
  const user=userEvent.setup();
  const clipboard=vi.spyOn(navigator.clipboard,'writeText').mockResolvedValue();
  mount(account(),adapter());
  const field=screen.getByLabelText('Wallet address');
  expect((field as HTMLInputElement).value).not.toContain(address);
  await user.click(screen.getByRole('button',{name:'Show address'}));
  expect(field).toHaveProperty('value',address);
  await user.click(screen.getByRole('button',{name:'Copy address'}));
  expect(clipboard).toHaveBeenCalledWith(address);
  await user.click(screen.getByRole('button',{name:'Hide address'}));
  expect((field as HTMLInputElement).value).not.toContain(address);
});

it('never exposes an unverified future deployment address or enables funding',()=>{
  const state=account({connected:false,deploymentStatus:'PENDING',
    deployment:{status:'PENDING',enabled:true},wallets:[]});
  mount(state,null);
  expect(screen.queryByLabelText('Wallet address')).toBeNull();
  expect(screen.getByText(/Do not fund a predicted address/)).toBeTruthy();
  expect(screen.getByRole('button',{name:'Fund Testnet wallet'})).toHaveProperty('disabled',true);
});

it('provides working profile management actions without requesting new wallet ownership',async()=>{
  const user=userEvent.setup();
  mount(account(),adapter());
  await user.click(screen.getByRole('button',{name:'Add another passkey'}));
  expect(actions.addPasskey).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button',{name:/Refresh wallet status/}));
  expect(actions.refreshDeployment).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button',{name:'Sign out'}));
  expect(actions.signOut).toHaveBeenCalledTimes(1);
});

it('requires mailbox verification and explicit consent before exposing email discovery',async()=>{
  const user=userEvent.setup();
  const request=vi.fn(async()=>{}),confirm=vi.fn(async()=>{}),optIn=vi.fn(async()=>{});
  const state=account({emailVerified:false,emailPaymentsEnabled:false,
    requestEmailVerification:request,confirmEmailVerification:confirm,
    setEmailPaymentsEnabled:optIn,deployment:{status:'CONFIRMED',enabled:true,address,spendingEnabled:true} as WalletAccount['deployment']});
  const view=mount(state,adapter());
  expect(screen.getByText(/Your email is private and cannot be looked up/)).toBeTruthy();
  await user.click(screen.getByRole('button',{name:'Send email verification code'}));
  expect(request).toHaveBeenCalledTimes(1);
  await user.type(screen.getByLabelText('8-digit email verification code'),'12345678');
  await user.click(screen.getByRole('button',{name:'Verify email'}));
  expect(confirm).toHaveBeenCalledWith('12345678');
  view.rerender(<MemoryRouter><PaymentContext.Provider value={adapter()}>
    <WalletAccountContext.Provider value={{...state,emailVerified:true}}><Profile/></WalletAccountContext.Provider>
  </PaymentContext.Provider></MemoryRouter>);
  await user.click(screen.getByRole('button',{name:'Allow people to pay my verified email'}));
  expect(optIn).toHaveBeenCalledWith(true);
});
