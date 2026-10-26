// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Asset, Networks, StrKey } from '@stellar/stellar-sdk';
import { PaymentContext } from '../payments/context';
import { Send } from '../payments/Send';
import { checkQuote, type Attempt, type Invoice, type InvoiceDetail, type PaymentAdapter } from '../payments/model';
import { Invoices } from './Invoices';
import { InvoiceCheckout } from './Checkout';
import { invoiceAdapter, parseInvoice } from './api';

vi.mock('qrcode.react',()=>({QRCodeSVG:({value,title}:{value:string;title:string})=><div title={title} data-testid="qr-value">{value}</div>}));
const address=StrKey.encodeContract(Buffer.alloc(32,1)),destination=StrKey.encodeContract(Buffer.alloc(32,2));
const request:Invoice={id:'70adce38-46c1-49a3-8a38-0e9cccf71756',network:'TESTNET',asset:'XLM',assetContract:Asset.native().contractId(Networks.TESTNET),invoiceReference:'INV-125',merchantName:'Test Merchant',destination,amountStroops:'10000000',paidStroops:'0',remainingStroops:'10000000',status:'unpaid',expiresAt:Date.now()+86400000,createdAt:Date.now(),expired:false,paymentPending:false};
function adapter():PaymentAdapter {
  return {network:'TESTNET',address,supportedDestinations:['contract'],canSign:true,persistentPreview:true,
    prepare:vi.fn(async intent=>({...intent,id:'quote',feeStroops:'100',feePayer:'sponsor',spendableStroops:'90000000',expiresAt:new Date(Date.now()+60000).toISOString()})),
    createAttempt:vi.fn(),approve:vi.fn(),getAttempt:vi.fn(),getAttemptByKey:vi.fn(async()=>null),listAttempts:vi.fn(async()=>({items:[]}))};
}
function mount(element:React.ReactNode,service:PaymentAdapter|null){return render(<MemoryRouter><PaymentContext.Provider value={service}>{element}</PaymentContext.Provider></MemoryRouter>);}
beforeEach(()=>localStorage.clear());
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('invoice checkout',()=>{
  it('supports keyboard-only review and approval, then exposes a receipt only after verified confirmation',async()=>{
    const service=adapter(),user=userEvent.setup(),hash='b'.repeat(64);
    const attempt:Attempt={id:'quote',network:'TESTNET',from:address,destination,amountStroops:'10000000',paymentRequestId:request.id,feeStroops:'100',createdAt:new Date().toISOString(),status:'awaiting_approval',verified:false};
    vi.mocked(service.createAttempt).mockResolvedValue(attempt);
    vi.mocked(service.approve).mockResolvedValue({...attempt,status:'pending',transactionHash:hash});
    mount(<Send request={request}/>,service);
    // The public invoice includes one navigation link, then the two read-only fields.
    await user.tab(); await user.tab(); await user.tab(); await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button',{name:'Preview payment'}));
    await user.keyboard('{Enter}');
    await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole('heading',{name:'Review and approve'})));
    expect(screen.getByText('0.0000100 XLM · sponsor pays, up to this limit')).toBeTruthy();
    expect(screen.getByRole('button',{name:'Approve exact payment'})).toHaveProperty('disabled',true);
    expect(service.approve).not.toHaveBeenCalled();
    await user.tab();expect(document.activeElement).toBe(screen.getByRole('checkbox'));
    await user.keyboard(' ');await user.tab();await user.keyboard('{Enter}');
    await screen.findByText('Pending confirmation');
    expect(service.approve).toHaveBeenCalledTimes(1);
    expect(service.createAttempt).toHaveBeenCalledWith(expect.objectContaining({paymentRequestId:request.id,amountStroops:'10000000'}),expect.any(String));
    expect(screen.queryByRole('link',{name:'Verified Testnet receipt'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Start a new payment'})).toBeNull();
    vi.mocked(service.getAttemptByKey).mockResolvedValue({...attempt,status:'confirmed',verified:true,transactionHash:hash});
    expect(document.activeElement).toBe(screen.getByRole('heading',{name:'Payment status'}));
    await user.tab();await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button',{name:'Check existing attempt'}));
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('link',{name:'Verified Testnet receipt'})).toHaveProperty('href',`https://stellar.expert/explorer/testnet/tx/${hash}`);
    await screen.findByRole('button',{name:'Start a new payment'});
    expect(service.prepare).toHaveBeenCalledTimes(1);expect(service.approve).toHaveBeenCalledTimes(1);
  });
  it('focuses an interrupted-approval error and keeps the same invoice attempt after reload',async()=>{
    const service=adapter(),user=userEvent.setup();
    const attempt:Attempt={id:'quote',network:'TESTNET',from:address,destination,amountStroops:'10000000',paymentRequestId:request.id,feeStroops:'100',createdAt:new Date().toISOString(),status:'awaiting_approval',verified:false};
    vi.mocked(service.createAttempt).mockResolvedValue(attempt);
    vi.mocked(service.approve).mockRejectedValue(Error('Connection interrupted. Check the existing payment.'));
    const view=mount(<Send request={request}/>,service);
    await user.click(screen.getByRole('button',{name:'Preview payment'}));
    await user.click(await screen.findByRole('checkbox'));
    await user.click(screen.getByRole('button',{name:'Approve exact payment'}));
    await waitFor(()=>expect(document.activeElement).toBe(screen.getByRole('alert')));
    expect(screen.getByRole('alert').textContent).toContain('Connection interrupted');
    const storageKey=`cherrypay:pending:TESTNET:${address}`,saved=localStorage.getItem(storageKey);
    expect(saved).toBeTruthy();view.unmount();
    vi.mocked(service.getAttemptByKey).mockResolvedValue({...attempt,status:'unknown'});
    mount(<Send request={request}/>,service);
    await screen.findByText('Outcome unknown — check status before retrying');
    expect(screen.queryByRole('button',{name:'Preview payment'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Start a new payment'})).toBeNull();
    expect(localStorage.getItem(storageKey)).toBe(saved);
    expect(service.prepare).toHaveBeenCalledTimes(1);expect(service.approve).toHaveBeenCalledTimes(1);
  });
  it('locks the destination and exact amount, persists recovery and includes the request in preparation',async()=>{
    const service=adapter();mount(<Send request={request}/>,service);
    expect(screen.getByLabelText('Recipient address')).toHaveProperty('readOnly',true);
    expect(screen.getByLabelText('Exact amount (XLM)')).toHaveProperty('value','1.0000000');
    await userEvent.click(screen.getByRole('button',{name:'Preview payment'}));
    await screen.findByRole('button',{name:'Approve exact payment'});
    expect(service.prepare).toHaveBeenCalledWith(expect.objectContaining({paymentRequestId:request.id,destination,amountStroops:'10000000'}),expect.any(String));
    expect(localStorage.getItem(`cherrypay:pending:TESTNET:${address}`)).toBeTruthy();
    expect(service.approve).not.toHaveBeenCalled();
  });
  it.each([{...request,expired:true},{...request,paymentPending:true},{...request,status:'paid' as const,paidStroops:'10000000',remainingStroops:'0'}])('blocks fresh payment for unavailable requests',r=>{
    mount(<Send request={r}/>,adapter());expect(screen.getByRole('button',{name:'Preview payment'})).toHaveProperty('disabled',true);
  });
  it('preserves an unknown saved payment instead of preparing another invoice',async()=>{
    localStorage.setItem(`cherrypay:pending:TESTNET:${address}`,'existing-payment-key');const service=adapter();mount(<Send request={request}/>,service);
    expect(screen.queryByRole('button',{name:'Preview payment'})).toBeNull();
    await userEvent.click(screen.getByRole('button',{name:'Check existing attempt'}));
    await screen.findByText('The attempt is not yet available. Check again later; do not submit a replacement.');expect(service.prepare).not.toHaveBeenCalled();
  });
  it('loads public terms before sign-in and rejects a link response for a different invoice',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({...request,id:'a'.repeat(36)}),{status:200,headers:{'Content-Type':'application/json'}}));vi.stubGlobal('fetch',fetcher);
    render(<MemoryRouter initialEntries={['/pay/'+request.id]}><PaymentContext.Provider value={null}><Routes><Route path="/pay/:requestId" element={<InvoiceCheckout/>}/></Routes></PaymentContext.Provider></MemoryRouter>);
    await screen.findByText(/Payment request identity mismatch/);expect(screen.queryByRole('button',{name:'Preview payment'})).toBeNull();
    expect(fetcher.mock.calls[0][0]).toBe('/api/v1/payment-requests/'+request.id);
  });
  it('rejects a quote if its invoice metadata changes even when recipient and amount agree',()=>{
    const intent={network:'TESTNET' as const,from:address,destination,amountStroops:'10000000',paymentRequestId:request.id};
    expect(()=>checkQuote({...intent,paymentRequestId:undefined,id:'q',feeStroops:'1',feePayer:'sponsor',spendableStroops:'90000000',expiresAt:new Date(Date.now()+60000).toISOString()},intent)).toThrow(/does not match/);
  });
});
describe('merchant invoices',()=>{
  it('creates a QR containing the saved invoice URL rather than an address and never spends',async()=>{
    const service=adapter(),detail:InvoiceDetail={...request,destination:address,walletId:'merchant',receipts:[],receiptsTruncated:false};
    const create=vi.fn(async input=>({...detail,...input}));
    service.invoices={create,get:vi.fn(async()=>detail),list:vi.fn(async()=>({items:[]})),unmatched:vi.fn(async()=>({items:[]})),allocate:vi.fn()};
    mount(<Invoices/>,service);const user=userEvent.setup();
    await user.click(screen.getByRole('button',{name:'New invoice'}));
    await user.type(screen.getByLabelText('Merchant name'),'Test Merchant');await user.type(screen.getByLabelText('Invoice reference'),'INV-125');await user.type(screen.getByLabelText('Invoice amount (Testnet XLM)'),'1');
    await user.click(screen.getByRole('button',{name:'Create invoice QR'}));
    expect((await screen.findByTestId('qr-value')).textContent).toBe(window.location.origin+'/pay/'+request.id);
    expect(screen.getByLabelText('Invoice payment link')).toHaveProperty('value',window.location.origin+'/pay/'+request.id);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({amountStroops:'10000000',network:'TESTNET',invoiceReference:'INV-125'}));expect(service.prepare).not.toHaveBeenCalled();
  });
  it('requires explicit confirmation and an evidence note to allocate an unmatched receipt',async()=>{
    const service=adapter(),detail:InvoiceDetail={...request,destination:address,walletId:'merchant',receipts:[],receiptsTruncated:false};
    const hash='a'.repeat(64),eventId=`TESTNET:${hash}:0:0`;
    service.invoices={create:vi.fn(),get:vi.fn(async()=>detail),list:vi.fn(async()=>({items:[detail]})),unmatched:vi.fn(async()=>({items:[{eventId,transactionHash:hash,from:destination,amountStroops:'10000000',ledger:1,closedAt:Date.now()}]})),allocate:vi.fn(async()=>({...detail,paidStroops:'10000000',remainingStroops:'0',status:'paid' as const}))};
    mount(<Invoices/>,service);const user=userEvent.setup();
    await user.click(await screen.findByRole('button',{name:/INV-125 ·/}));
    await user.click(screen.getByText('Assign an unmatched receipt'));
    expect(await screen.findByRole('button',{name:'Assign receipt to invoice'})).toHaveProperty('disabled',true);
    await user.selectOptions(screen.getByLabelText('Verified incoming receipt'),eventId);await user.type(screen.getByLabelText('Evidence / reconciliation note'),'Customer supplied matching invoice reference');await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button',{name:'Assign receipt to invoice'}));
    await waitFor(()=>expect(service.invoices!.allocate).toHaveBeenCalledWith(request.id,eventId,'Customer supplied matching invoice reference'));expect(service.prepare).not.toHaveBeenCalled();
  });
});
describe('invoice response verification',()=>{
  it('rejects wrong network, token contract and fabricated totals',()=>{
    expect(parseInvoice(request)).toEqual(request);
    for(const patch of [{network:'MAINNET'},{assetContract:destination},{paidStroops:'1'},{remainingStroops:'0'},{status:'paid'}])expect(()=>parseInvoice({...request,...patch})).toThrow();
  });
  it('isolates merchant ownership on reads',async()=>{
    const api=vi.fn(async()=>({...request,walletId:'someone-else',receipts:[],receiptsTruncated:false}));
    await expect(invoiceAdapter(api,'merchant',address).get(request.id)).rejects.toThrow('Invoice wallet mismatch');
  });
});
