// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {StrKey} from '@stellar/stellar-sdk';
import {PaymentContext} from './context';
import {Receive} from './Receive';
import {NETWORK,type PaymentAdapter,type Attempt} from './model';
const address=StrKey.encodeContract(Buffer.alloc(32,1)),sender=StrKey.encodeEd25519PublicKey(Buffer.alloc(32,2));
const incoming:Attempt={id:'receipt',network:NETWORK,from:sender,destination:address,amountStroops:'10000000',feeStroops:'0',feeKnown:false,createdAt:'2026-10-26T00:00:00Z',status:'confirmed',verified:true,transactionHash:'a'.repeat(64)};
const balance=()=>({amountStroops:'100000000000',ledger:500,updatedAt:Date.now()});
function adapter():PaymentAdapter{return {network:NETWORK,address,supportedDestinations:['contract'],receive:{address,route:'contract',instructions:'Use native Testnet XLM SAC transfers.'},getBalance:vi.fn(async()=>balance()),listTransfers:vi.fn(async()=>({items:[]})),prepare:vi.fn(),createAttempt:vi.fn(),approve:vi.fn(),getAttempt:vi.fn(),getAttemptByKey:vi.fn(),listAttempts:vi.fn()};}
function mount(a:PaymentAdapter){return render(<MemoryRouter><PaymentContext.Provider value={a}><Receive/></PaymentContext.Provider></MemoryRouter>);}
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();});
it('shows the C-address and receives from an external G-account without requesting a signature',async()=>{
 const a=adapter();vi.mocked(a.listTransfers!).mockResolvedValue({items:[incoming]});mount(a);
 expect(await screen.findByText('Received 1.0000000 XLM')).toBeTruthy();expect(screen.getByText('10000.0000000 XLM')).toBeTruthy();
 expect(screen.getByText(/sender does not need a Cherry Pay account/)).toBeTruthy();expect(screen.getByText(/Classic G-address payments/)).toBeTruthy();
 expect(screen.getByRole('link',{name:'Verified Testnet receipt'}).getAttribute('href')).toContain('a'.repeat(64));
 expect(a.approve).not.toHaveBeenCalled();expect(a.createAttempt).not.toHaveBeenCalled();
});
it('refreshes incoming transfers and balance without overlapping or continuing after unmount',async()=>{
 vi.useFakeTimers();const a=adapter(),view=mount(a);await act(async()=>{});
 expect(a.getBalance).toHaveBeenCalledTimes(1);
 vi.mocked(a.listTransfers!).mockResolvedValue({items:[incoming]});vi.mocked(a.getBalance!).mockResolvedValue({...balance(),amountStroops:'100010000000',ledger:501});
 await act(async()=>{await vi.advanceTimersByTimeAsync(15000);});expect(screen.getByText('Received 1.0000000 XLM')).toBeTruthy();expect(screen.getByText('10001.0000000 XLM')).toBeTruthy();
 expect(a.getBalance).toHaveBeenCalledTimes(2);view.unmount();await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});expect(a.getBalance).toHaveBeenCalledTimes(2);
});
it.each(['unverified','foreign-wallet','mainnet'])('does not publish a %s receipt',async kind=>{
 const a=adapter();vi.mocked(a.listTransfers!).mockResolvedValue({items:[{...incoming,...(kind==='unverified'?{verified:false}:kind==='foreign-wallet'?{destination:sender}:{network:'PUBLIC' as typeof NETWORK})}]});mount(a);
 await screen.findByText('Received-transfer history could not be refreshed. Check again.');expect(screen.queryByRole('link',{name:'Verified Testnet receipt'})).toBeNull();
 expect(screen.getByText('10000.0000000 XLM')).toBeTruthy();
});
it('does not imply zero balance after an RPC failure and keeps the supported receive address usable',async()=>{
 const a=adapter();vi.mocked(a.getBalance!).mockRejectedValue(Error('RPC unavailable'));mount(a);await screen.findByText('Balance could not be refreshed. Check again.');
 expect(screen.queryByText('0.0000000 XLM')).toBeNull();expect(screen.getByLabelText('Your supported Testnet destination')).toHaveProperty('value',address);
});
