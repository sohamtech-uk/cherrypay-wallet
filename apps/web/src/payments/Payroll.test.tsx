// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { StrKey } from '@stellar/stellar-sdk';
import { Payroll, parseRecipients, resolvePayrollRecipients } from './Payroll';
import { PaymentContext } from './context';
import type { Attempt, PaymentAdapter, PayRun } from './model';
const address = StrKey.encodeContract(Buffer.alloc(32,1)), destination = StrKey.encodeEd25519PublicKey(Buffer.alloc(32,2));
function fixture() {
  const a: Attempt = { id:'a-1',network:'TESTNET',from:address,destination,amountStroops:'10000001',feeStroops:'10000000',status:'awaiting_approval',verified:false,createdAt:new Date().toISOString() };
  let run: PayRun = { id:'r-1',network:'TESTNET',reference:'october',maxFeeStroops:'10000000',totalStroops:'10000001',confirmedCount:0,status:'draft',items:[{reference:'employee-1',destination,amountStroops:'10000001',attempt:null}] };
  const adapter: PaymentAdapter = {
    network:'TESTNET',address,supportedDestinations:['classic'],canSign:true,
    prepare:vi.fn(),createAttempt:vi.fn(),getAttempt:vi.fn(),getAttemptByKey:vi.fn(),listAttempts:vi.fn(),
    approve:vi.fn(async () => { a.status='unknown'; run={...run,items:[{...run.items[0],attempt:{...a}}]}; throw Error('Connection lost'); }),
    getQuote:vi.fn(async () => ({...a,feePayer:'sponsor' as const,spendableStroops:'100000000',expiresAt:new Date(Date.now()+60000).toISOString()})),
    payroll:{ create:vi.fn(async () => structuredClone(run)),get:vi.fn(async () => structuredClone(run)),list:vi.fn(async () => ({items:[{id:run.id,reference:run.reference,createdAt:Date.now(),recipientCount:1}]})),prepare:vi.fn(async () => { run={...run,status:'in_progress',items:[{...run.items[0],attempt:{...a}}]}; return {...a}; }) },
  };
  return adapter;
}
function mount(adapter: PaymentAdapter | null) { return render(<MemoryRouter><PaymentContext.Provider value={adapter}><Payroll/></PaymentContext.Provider></MemoryRouter>); }
afterEach(cleanup);
it('keeps payroll disabled without a connected signing wallet', () => { mount(null); expect(screen.queryByRole('button',{name:'Save pay run'})).toBeNull(); });
it('parses exact XLM amounts and rejects duplicate recipients and invalid references', () => {
  const adapter = fixture();
  expect(parseRecipients(`employee-1, ${destination}, 1.0000001`,adapter)[0].amountStroops).toBe('10000001');
  for (const value of [`employee-1,${destination},0`,`employee-1,${destination},1.00000001`,`employee-1,${destination},1\nemployee-2,${destination},2`,`private name,${destination},1`]) expect(() => parseRecipients(value,adapter)).toThrow();
});
it('requires exact payment review and recovers an approval timeout by reading the saved run',async () => {
  const adapter = fixture(), user = userEvent.setup(); const view=mount(adapter);
  await user.click(await screen.findByRole('button',{name:'october · 1 recipients'}));
  await user.click(await screen.findByRole('button',{name:'Review payment'}));
  expect(await screen.findByRole('button',{name:'Approve with passkey'})).toHaveProperty('disabled',true);
  await user.click(screen.getByRole('checkbox'));
  await user.dblClick(screen.getByRole('button',{name:'Approve with passkey'}));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Connection lost'));
  expect(adapter.approve).toHaveBeenCalledTimes(1); expect(adapter.payroll!.prepare).toHaveBeenCalledTimes(1);
  view.unmount(); mount(adapter);
  await user.click(await screen.findByRole('button',{name:'october · 1 recipients'}));
  await screen.findByText('Outcome unknown — check status before retrying');
  expect(screen.queryByRole('button',{name:'Review payment'})).toBeNull();
  expect(adapter.approve).toHaveBeenCalledTimes(1); expect(adapter.payroll!.prepare).toHaveBeenCalledTimes(1);
});
it('saving a pay run never invokes the signer',async () => {
  const adapter=fixture(),user=userEvent.setup(); mount(adapter);
  await user.type(screen.getByLabelText('Unique pay run reference'),'october');
  await user.type(screen.getByLabelText('Recipients: reference, Stellar address or verified email, XLM amount'),`employee-1,${destination},1.0000001`);
  await user.click(screen.getByRole('button',{name:'Save pay run'}));
  await screen.findByRole('heading',{name:'october'});
  expect(adapter.payroll!.create).toHaveBeenCalledWith({network:'TESTNET',reference:'october',maxFeeStroops:'10000000',items:[{reference:'employee-1',destination,amountStroops:'10000001'}]});
  expect(adapter.approve).not.toHaveBeenCalled(); expect(adapter.payroll!.prepare).not.toHaveBeenCalled();
});

it('resolves opted-in payroll emails before saving immutable Stellar destinations',async()=>{
  const adapter=fixture(),contract=StrKey.encodeContract(Buffer.alloc(32,12));
  adapter.supportedDestinations=['classic','contract'];
  adapter.resolveRecipientEmail=vi.fn(async (email: string)=>({network:'TESTNET' as const,email,address:contract,mailboxVerified:true as const,walletBindingVerified:true as const,legalIdentityVerified:false as const}));
  const result=await resolvePayrollRecipients('employee-1,employee@example.com,1.5000001',adapter);
  expect(result.items).toEqual([{reference:'employee-1',destination:contract,amountStroops:'15000001'}]);
  expect(result.aliases).toEqual({'employee-1':'employee@example.com'});
  expect(adapter.approve).not.toHaveBeenCalled();
  await expect(resolvePayrollRecipients('employee-1,employee@example.com,1\nemployee-2,employee@example.com,2',adapter))
    .rejects.toThrow('unique');
});
it('rejects payroll recipient email when lookup is unavailable or unverified',async()=>{
  const adapter=fixture();
  await expect(resolvePayrollRecipients('employee-1,employee@example.com,1',adapter))
    .rejects.toThrow('unavailable');
});
