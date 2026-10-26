// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { StrKey } from '@stellar/stellar-sdk';
import App from '../App';
import { Business } from '../invoices/Business';
import { FundingPrompt } from './FundingPrompt';
import { PaymentAttention } from './PaymentAttention';
import { History } from './History';
import { PaymentContext } from './context';
import { WalletAccountContext, type WalletAccount } from './account-context';
import { activityCsv, filterActivity } from './activity';
import type { Attempt, Invoice, PaymentAdapter } from './model';

const address = StrKey.encodeContract(Buffer.alloc(32, 3)), other = StrKey.encodeContract(Buffer.alloc(32, 4));
const receipt: Attempt = { id: 'TESTNET:receipt:0:1', network: 'TESTNET', from: other, destination: address, amountStroops: '9007199254740993', status: 'confirmed', verified: true, transactionHash: 'a'.repeat(64), feeStroops: '0', createdAt: '2026-10-26T01:00:00Z' };
const invoice: Invoice = { id: '12345678-1234-4234-8234-123456789012', network: 'TESTNET', invoiceReference: 'INV-1', merchantName: 'Test business', amountStroops: '9007199254740994', paidStroops: '9007199254740993', remainingStroops: '1', asset: 'XLM', assetContract: other, destination: address, status: 'partially_paid', expired: false, paymentPending: false, expiresAt: Date.now()+86400000, createdAt: Date.now() };
function adapter(): PaymentAdapter { return { network: 'TESTNET', address, supportedDestinations: ['contract'], prepare: vi.fn(), createAttempt: vi.fn(), approve: vi.fn(), getAttempt: vi.fn(), getAttemptByKey: vi.fn(), listAttempts: vi.fn(async()=>({items:[]})), listTransfers: vi.fn(async()=>({items:[receipt]})), invoices: {list:vi.fn(async()=>({items:[invoice],nextCursor:'next'})),unmatched:vi.fn(async()=>({items:[],nextCursor:'next'})),get:vi.fn(),create:vi.fn(),allocate:vi.fn()} }; }
function mount(view: React.ReactNode, service = adapter()) { return render(<MemoryRouter><PaymentContext.Provider value={service}>{view}</PaymentContext.Provider></MemoryRouter>); }
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();localStorage.clear();});

it('has one sign-in screen and preserves the requested payment route',()=>{
  render(<MemoryRouter initialEntries={['/send']}><App/></MemoryRouter>);
  expect(screen.getAllByRole('heading',{level:1})).toHaveLength(1);
  expect(screen.getByRole('heading',{name:'Welcome to Cherry Wallet'})).toBeTruthy();
  expect(screen.queryByText('Signing service not connected')).toBeNull();
  expect(screen.getByRole('link',{name:'Send'}).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('navigation',{name:'Main navigation'})).toBeNull();
});
it('shows exact invoice totals and discloses pagination rather than implying all-time totals',async()=>{
  mount(<Business/>);
  expect(await screen.findByText('900719925.4740993')).toBeTruthy();
  expect(screen.getByText('0.0000001')).toBeTruthy();
  expect(screen.getByText(/Summary of 1 latest invoices · more in Invoices/)).toBeTruthy();
  expect(screen.getByRole('link',{name:/INV-1/}).getAttribute('href')).toContain('invoice='+invoice.id);
});
it('fails closed on foreign-wallet invoice data',async()=>{
  const service=adapter();vi.mocked(service.invoices!.list).mockResolvedValue({items:[{...invoice,destination:other}]});
  mount(<Business/>,service);await screen.findByRole('alert');expect(screen.queryByText('900719925.4740993')).toBeNull();
});
it('clears business totals after a failed refresh',async()=>{
  const service=adapter();mount(<Business/>,service);await screen.findByText('900719925.4740993');
  vi.mocked(service.invoices!.list).mockRejectedValue(Error('offline'));await userEvent.click(screen.getByRole('button',{name:'Refresh business overview'}));
  await screen.findByRole('alert');expect(screen.queryByText('900719925.4740993')).toBeNull();
});
it('keeps connected-wallet funding visible and never offers a replacement for pending funding',async()=>{
  const fundTestnet=vi.fn(async()=>{});
  const account={authenticated:true,connected:true,busy:false,error:'',deployment:{address,status:'CONFIRMED',funding:{status:'AVAILABLE'}},fundTestnet} as unknown as WalletAccount;
  const view=render(<MemoryRouter><WalletAccountContext.Provider value={account}><FundingPrompt/></WalletAccountContext.Provider></MemoryRouter>);
  await userEvent.click(screen.getByRole('button',{name:'Fund Testnet wallet'}));expect(fundTestnet).toHaveBeenCalledTimes(1);
  view.rerender(<MemoryRouter><WalletAccountContext.Provider value={{...account,deployment:{...account.deployment!,funding:{...account.deployment!.funding!,status:'PENDING'}}}}><FundingPrompt/></WalletAccountContext.Provider></MemoryRouter>);
  expect(screen.queryByRole('button',{name:'Fund Testnet wallet'})).toBeNull();expect(screen.getByText(/Waiting for confirmation/)).toBeTruthy();
});
it('surfaces uncertain attempts without creating, cancelling or resubmitting a payment',async()=>{
  const service=adapter();vi.mocked(service.listAttempts).mockResolvedValue({items:[{...receipt,from:address,destination:other,status:'unknown',verified:false}]});
  mount(<PaymentAttention adapter={service}/>,service);
  expect(await screen.findByText(/Outcome unknown/)).toBeTruthy();
  expect(screen.getByRole('link',{name:'View status'})).toBeTruthy();expect(service.prepare).not.toHaveBeenCalled();expect(service.approve).not.toHaveBeenCalled();
});
it('never treats a confirmed-but-unverified attempt as complete',async()=>{
  const service=adapter();vi.mocked(service.listAttempts).mockResolvedValue({items:[{...receipt,from:address,destination:other,verified:false}]});
  mount(<PaymentAttention adapter={service}/>,service);expect(await screen.findByText('Awaiting verification')).toBeTruthy();
});
it('filters activity by direction and reference on the current page',async()=>{
  const service=adapter();vi.mocked(service.listTransfers!).mockResolvedValue({items:[receipt,{...receipt,id:'sent-1',from:address,destination:other,paymentRequestId:invoice.id}]});
  mount(<History/>,service);await screen.findByText('Received 900719925.4740993 XLM');
  await userEvent.selectOptions(screen.getByLabelText('Direction'),'sent');expect(screen.queryByText('Received 900719925.4740993 XLM')).toBeNull();
  await userEvent.type(screen.getByLabelText('Search this page'),invoice.id);expect(screen.getByText('Sent 900719925.4740993 XLM')).toBeTruthy();
  expect(filterActivity([receipt],address,'received','no-match')).toHaveLength(0);
});
it('exports only verified owned receipts, preserves exact amounts and neutralizes spreadsheet formulas',()=>{
  const csv=activityCsv([{...receipt,id:'=FORMULA',paymentRequestId:'request-123'},{...receipt,id:'unknown',status:'unknown'},{...receipt,id:'foreign',from:other,destination:other}],address);
  expect(csv).toContain('900719925.4740993');expect(csv).toContain('request-123');expect(csv).toContain('"\'=FORMULA"');expect(csv).not.toContain('unknown');expect(csv).not.toContain('foreign');expect(csv.split('\r\n')).toHaveLength(2);
});
it('removes pending-payment data when the dashboard unmounts and ignores late responses',async()=>{
  const service=adapter();let finish!: (r:{items:Attempt[]})=>void;service.listAttempts=vi.fn(()=>new Promise<{items:Attempt[]}>(resolve=>{finish=resolve;}));
  const view=mount(<PaymentAttention adapter={service}/>,service);view.unmount();await act(async()=>{finish({items:[{...receipt,from:address,status:'unknown'}]});});expect(screen.queryByText(/Outcome unknown/)).toBeNull();
});

it('prefills only the recipient for a repeat payment and still requires a fresh amount and approval',()=>{
  const service=adapter();render(<MemoryRouter initialEntries={['/send?to='+other]}><App paymentAdapter={service}/></MemoryRouter>);
  expect(screen.getByLabelText('Recipient address')).toHaveProperty('value',other);
  expect(screen.getByLabelText('Exact amount (XLM)')).toHaveProperty('value','');
  expect(service.prepare).not.toHaveBeenCalled();expect(service.approve).not.toHaveBeenCalled();
});
