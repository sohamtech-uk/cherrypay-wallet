// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { StrKey } from '@stellar/stellar-sdk';
import { PaymentContext } from './context';
import { Send } from './Send';
import { Receive } from './Receive';
import { History } from './History';
import { NETWORK, type PaymentAdapter, type Attempt } from './model';
const address = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const attempt: Attempt = { id: 'attempt-1', network: NETWORK, from: address, destination: address, amountStroops: '10000001', feeStroops: '100', createdAt: '2026-10-25T12:00:00Z', status: 'pending', verified: false };
function service(): PaymentAdapter { return { network: NETWORK, address, supportedDestinations: ['classic'], receive: { address, route: 'classic', instructions: 'Send Testnet XLM only.' }, prepare: vi.fn(async intent => ({ ...intent, id: 'q', feeStroops: '100', feePayer: 'wallet', spendableStroops: '100000000', expiresAt: new Date(Date.now() + 60000).toISOString() })), createAttempt: vi.fn(async () => ({ ...attempt, status: 'awaiting_approval' as const })), approve: vi.fn(async () => attempt), getAttempt: vi.fn(async () => attempt), getAttemptByKey: vi.fn(async () => attempt), listAttempts: vi.fn(async () => ({ items: [] })) }; }
function mount(element: React.ReactNode, adapter: PaymentAdapter | null) { return render(<MemoryRouter><PaymentContext.Provider value={adapter}>{element}</PaymentContext.Provider></MemoryRouter>); }
beforeEach(() => localStorage.clear());
afterEach(cleanup);
describe('wallet screens', () => {
  it('does not enable sending or expose a receive QR without backend support', () => { mount(<><Send/><Receive/></>, null); expect(screen.getByText('Signing service not connected')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Approve exact payment' })).toBeNull(); expect(screen.queryByTitle('Stellar Testnet destination address')).toBeNull(); });
  it('renders the supported address and accessible local QR', () => { mount(<Receive/>, service()); expect(screen.getByLabelText('Your supported Testnet destination')).toHaveProperty('value', address); expect(screen.getByTitle('Stellar Testnet destination address')).toBeTruthy(); });
  it('reviews exact amounts and recovers a submission timeout without resending', async () => {
    const adapter = service(); vi.mocked(adapter.approve).mockRejectedValue(new Error('Connection lost. Check existing attempt.'));
    const user = userEvent.setup(); const view = mount(<Send/>, adapter);
    await user.type(screen.getByLabelText('Recipient address'), address);
    await user.type(screen.getByLabelText('Exact amount (XLM)'), '1.0000001');
    await user.click(screen.getByRole('button', { name: 'Preview payment' }));
    expect(await screen.findByText('1.0000101 XLM')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve exact payment' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('checkbox'));
    await user.dblClick(screen.getByRole('button', { name: 'Approve exact payment' }));
    await screen.findByText('Connection lost. Check existing attempt.');
    expect(adapter.createAttempt).toHaveBeenCalledTimes(1); expect(adapter.approve).toHaveBeenCalledTimes(1);
    view.unmount(); mount(<Send/>, adapter);
    expect(screen.queryByRole('button', { name: 'Preview payment' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check existing attempt' }));
    await screen.findByText('Pending confirmation');
    expect(adapter.approve).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Start a new payment' })).toBeNull();
  });
  it('allows retrying a failed history read', async () => { const adapter = service(); vi.mocked(adapter.listAttempts).mockRejectedValueOnce(new Error('offline')); mount(<History/>, adapter); await screen.findByRole('alert'); await userEvent.click(screen.getByRole('button', { name: 'Retry loading' })); await waitFor(() => expect(screen.getByText(/No transactions yet/)).toBeTruthy()); });
});

it('rejects an expired quote before creating an attempt', async () => {
  const adapter = service(); const user = userEvent.setup();
  vi.mocked(adapter.prepare).mockImplementation(async intent => ({ ...intent, id: 'expired', feeStroops: '100', feePayer: 'wallet', spendableStroops: '100000000', expiresAt: '2020-01-01T00:00:00Z' }));
  mount(<Send/>, adapter);
  await user.type(screen.getByLabelText('Recipient address'), address);
  await user.type(screen.getByLabelText('Exact amount (XLM)'), '1');
  await user.click(screen.getByRole('button', { name: 'Preview payment' }));
  await screen.findByText('Fee preview expired. Request a new preview.');
  expect(adapter.createAttempt).not.toHaveBeenCalled();
});
it('offers manual copy recovery when clipboard permission is denied', async () => {
  const user = userEvent.setup();
  vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
  mount(<Receive/>, service());
  await user.click(screen.getByRole('button', { name: 'Copy address' }));
  expect(await screen.findByText(/Copy unavailable/)).toBeTruthy();
});
it('can reach payment fields with the keyboard', async () => {
  const user = userEvent.setup(); mount(<Send/>, service());
  await user.tab(); expect(document.activeElement).toBe(screen.getByLabelText('Recipient address'));
  await user.tab(); expect(document.activeElement).toBe(screen.getByLabelText('Exact amount (XLM)'));
  await user.tab(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Preview payment' }));
});

it('saves the recovery key before a persistent preview and recovers its timeout without a replacement', async () => {
  const adapter = service(); adapter.persistentPreview = true;
  vi.mocked(adapter.prepare).mockImplementation(async (_intent, key) => {
    expect(localStorage.getItem(`cherrypay:pending:TESTNET:${address}`)).toBe(key);
    throw Error('Preparation timed out. Check existing attempt.');
  });
  const user = userEvent.setup(); mount(<Send/>, adapter);
  await user.type(screen.getByLabelText('Recipient address'), address);
  await user.type(screen.getByLabelText('Exact amount (XLM)'), '1');
  await user.click(screen.getByRole('button', { name: 'Preview payment' }));
  await screen.findByText('Preparation timed out. Check existing attempt.');
  expect(screen.queryByRole('button', { name: 'Preview payment' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Check existing attempt' }));
  expect(adapter.prepare).toHaveBeenCalledTimes(1); expect(adapter.createAttempt).not.toHaveBeenCalled(); expect(adapter.approve).not.toHaveBeenCalled();
});
it('gates send on a missing transaction signer even for an authenticated adapter', () => {
  const adapter = service(); adapter.canSign = false; mount(<Send/>, adapter);
  expect(screen.getByText('Signing service not connected')).toBeTruthy();
});
it('cancels the persisted preview before editing and only then clears the recovery key', async () => {
  const adapter = service(); adapter.persistentPreview = true;
  adapter.cancelAttempt = vi.fn(async () => ({ ...attempt, id: 'q', status: 'rejected' as const }));
  const user = userEvent.setup(); mount(<Send/>, adapter);
  await user.type(screen.getByLabelText('Recipient address'), address); await user.type(screen.getByLabelText('Exact amount (XLM)'), '1.0000001');
  await user.click(screen.getByRole('button', { name: 'Preview payment' }));
  await screen.findByRole('button', { name: 'Edit payment' });
  expect(localStorage.getItem(`cherrypay:pending:TESTNET:${address}`)).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Edit payment' }));
  await screen.findByRole('button', { name: 'Preview payment' });
  expect(adapter.cancelAttempt).toHaveBeenCalledWith('q'); expect(localStorage.getItem(`cherrypay:pending:TESTNET:${address}`)).toBeNull();
});

it('resets a missing or unsigned payment only after server confirmation and enables a new recipient',async()=>{
 const adapter=service(),key='safe-reset-saved-key',storageKey=`cherrypay:pending:TESTNET:${address}`;
 adapter.resetAttempt=vi.fn(async()=>{});localStorage.setItem(storageKey,key);mount(<Send/>,adapter);
 await userEvent.click(screen.getByRole('button',{name:'Reset and change recipient'}));
 await screen.findByLabelText('Recipient address');expect(localStorage.getItem(storageKey)).toBeNull();expect(adapter.resetAttempt).toHaveBeenCalledWith(key);
 expect(screen.getByLabelText('Recipient address')).toHaveProperty('value','');expect(adapter.createAttempt).not.toHaveBeenCalled();expect(adapter.approve).not.toHaveBeenCalled();
});
it('keeps the recovery key if a submitted payment or unavailable server prevents reset',async()=>{
 const adapter=service(),key='unresolved-saved-key',storageKey=`cherrypay:pending:TESTNET:${address}`;
 adapter.resetAttempt=vi.fn(async()=>{throw Error('Payment may already be submitted.');});localStorage.setItem(storageKey,key);mount(<Send/>,adapter);
 await userEvent.click(screen.getByRole('button',{name:'Reset and change recipient'}));await screen.findByText('Payment may already be submitted.');
 expect(localStorage.getItem(storageKey)).toBe(key);expect(screen.queryByLabelText('Recipient address')).toBeNull();expect(adapter.createAttempt).not.toHaveBeenCalled();
});


it('automatically refreshes a saved unresolved payment every five seconds without reapproving', async () => {
  const adapter = service(), key = 'auto-refresh-saved-key';
  const storageKey = `cherrypay:pending:TESTNET:${address}`;
  localStorage.setItem(storageKey, key);
  vi.mocked(adapter.getAttemptByKey).mockResolvedValue({ ...attempt, status: 'unknown', transactionHash: '3'.repeat(64) });
  const interval = vi.spyOn(window, 'setInterval');
  mount(<Send/>, adapter);
  await waitFor(() => expect(adapter.getAttemptByKey).toHaveBeenCalledWith(key));
  expect(interval).toHaveBeenCalledWith(expect.any(Function), 5000);
  expect(await screen.findByText('Outcome unknown — check status before retrying')).toBeTruthy();
  expect(screen.getByText(/Status refreshes automatically every 5 seconds/)).toBeTruthy();
  expect(adapter.createAttempt).not.toHaveBeenCalled();
  expect(adapter.approve).not.toHaveBeenCalled();
  interval.mockRestore();
});

it('polls unresolved transaction detail every five seconds until a terminal result', async () => {
  const adapter = service();
  vi.mocked(adapter.getAttempt)
    .mockResolvedValueOnce({ ...attempt, status: 'unknown', transactionHash: '3'.repeat(64) })
    .mockResolvedValueOnce({ ...attempt, status: 'confirmed', verified: true, transactionHash: '3'.repeat(64) });
  const interval = vi.spyOn(window, 'setInterval');
  render(<MemoryRouter initialEntries={['/history/attempt-1']}><PaymentContext.Provider value={adapter}><Routes><Route path="/history/:attemptId" element={<History/>}/></Routes></PaymentContext.Provider></MemoryRouter>);
  expect(await screen.findByText('Outcome unknown — check status before retrying')).toBeTruthy();
  await waitFor(() => expect(interval).toHaveBeenCalledWith(expect.any(Function), 5000));
  const poll = interval.mock.calls.find(call => call[1] === 5000)?.[0] as TimerHandler;
  expect(typeof poll).toBe('function');
  await (poll as () => void)();
  await waitFor(() => expect(screen.getByText('Confirmed and verified')).toBeTruthy());
  expect(adapter.getAttempt).toHaveBeenCalledTimes(2);
  interval.mockRestore();
});
