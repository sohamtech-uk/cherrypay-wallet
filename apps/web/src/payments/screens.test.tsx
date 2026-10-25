// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
