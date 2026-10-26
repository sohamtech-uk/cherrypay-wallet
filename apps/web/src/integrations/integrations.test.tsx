// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import App from '../App';
import { StrKey } from '@stellar/stellar-sdk';
import { AuroraPayment } from './AuroraPayment';
import { RecipientIntelligence } from './RecipientIntelligence';
import { auroraClient, BASE_USDC, STELLAR_USDC, RECOVERY_KEY, decodeQuote, inputAmount, loadRecipientIntelligence, units, type AuroraQuote, type SwapStatus } from './client';

const recipient = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const other = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const refundTo = '0x' + '1'.repeat(40), depositAddress = '0x' + '2'.repeat(40);
const makeQuote = (): AuroraQuote => ({ provider: 'Aurora Intents', network: 'MAINNET', sourceAsset: BASE_USDC, destinationAsset: STELLAR_USDC, recipient, refundTo, amountIn: '10000001', amountOut: '98000001', minAmountOut: '97020000', depositAddress, expiresAt: new Date(Date.now() + 900_000).toISOString(), slippageBps: 100, refundFee: '10000', withdrawFee: '100000' });
const makeStatus = (quote: AuroraQuote, status: SwapStatus['status'] = 'PENDING_DEPOSIT'): SwapStatus => ({ quote, status, checkedAt: new Date().toISOString(), originTxHashes: [], destinationTxHashes: [], amountOut: null });
const coverage = (address = recipient) => ({ provider: 'Nansen', chain: 'stellar', address, network: 'MAINNET', status: 'unsupported', providerCalled: false, coverageVerifiedAt: '2026-10-25', message: 'No Nansen assessment was performed.', notice: 'Address syntax does not prove identity.' });
const mount = (component: React.ReactNode) => render(<MemoryRouter>{component}</MemoryRouter>);
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name: string, callback: () => unknown) => callback()) } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function services() {
  const quote = makeQuote();
  const capabilities = vi.spyOn(auroraClient, 'capabilities').mockResolvedValue({ enabled: true, statusAvailable: true, network: 'MAINNET' });
  const preview = vi.spyOn(auroraClient, 'quote').mockResolvedValue(quote);
  const status = vi.spyOn(auroraClient, 'status').mockResolvedValue(makeStatus(quote));
  return { quote, capabilities, preview, status };
}
async function fill() {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByLabelText('Recipient on Stellar mainnet')).toHaveProperty('disabled', false));
  await user.type(screen.getByLabelText('Recipient on Stellar mainnet'), recipient);
  await user.type(screen.getByLabelText('Pay from Base USDC'), '10.000001');
  await user.type(screen.getByLabelText('Your Base refund address'), refundTo);
  await user.click(screen.getByRole('button', { name: 'Review Aurora quote' }));
  await screen.findByRole('heading', { name: 'Review before funding' });
  return user;
}
describe('cross-chain review and recovery', () => {
  it('labels the full cross-chain screen and browser title as mainnet, not Testnet', async () => {
    services(); render(<MemoryRouter initialEntries={['/pay-from-another-chain']}><App paymentAdapter={null}/></MemoryRouter>);
    await screen.findByRole('heading', { name: 'Pay from another chain' });
    await waitFor(() => expect(document.title).toBe('Cherry Wallet — Mainnet USDC'));
    expect(screen.queryByLabelText('Stellar Testnet only')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect with passkey' })).toBeNull();
  });
  it('keeps the Testnet deployment visibly on Testnet and exposes no mainnet funding form', async () => {
    const f = services(); f.capabilities.mockResolvedValue({ enabled: false, statusAvailable: true, network: 'TESTNET' });
    render(<MemoryRouter initialEntries={['/pay-from-another-chain']}><App paymentAdapter={null}/></MemoryRouter>);
    await screen.findByText('Stellar Testnet · cross-chain funding unavailable');
    expect(document.title).toBe('Cherry Pay Wallet — Testnet');
    expect(screen.queryByLabelText('Recipient on Stellar mainnet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review Aurora quote' })).toBeNull();
    expect(f.preview).not.toHaveBeenCalled();
  });
  it('shows exact net output, persists before funding, and reloads status without another quote', async () => {
    const f = services(), view = mount(<AuroraPayment/>), user = await fill();
    expect(screen.getByText('9.8000001 USDC')).toBeTruthy();
    expect(screen.getByText('9.702 USDC')).toBeTruthy();
    expect(screen.queryByTitle('Base mainnet USDC transfer request')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save and show funding instructions' })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('checkbox'));
    await user.dblClick(screen.getByRole('button', { name: 'Save and show funding instructions' }));
    await screen.findByTitle('Base mainnet USDC transfer request');
    expect(JSON.parse(localStorage.getItem(RECOVERY_KEY)!).quote.depositAddress).toBe(depositAddress);
    expect(screen.getByLabelText('Base deposit address')).toHaveProperty('value', depositAddress);
    view.unmount(); mount(<AuroraPayment/>);
    await screen.findByText('Awaiting deposit'); expect(f.preview).toHaveBeenCalledTimes(1); expect(f.status).toHaveBeenCalledTimes(2);
  });
  it('recovers an existing mainnet record on Testnet without exposing deposit controls', async () => {
    const f = services(); f.capabilities.mockResolvedValue({ enabled: false, statusAvailable: true, network: 'TESTNET' });
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ version: 1, reviewed: true, quote: f.quote }));
    mount(<AuroraPayment/>);
    await screen.findByText('Awaiting deposit');
    expect(screen.queryByTitle('Base mainnet USDC transfer request')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy deposit address' })).toBeNull();
    expect(f.preview).not.toHaveBeenCalled(); expect(f.status).toHaveBeenCalledTimes(1);
  });
  it('never reveals a QR when durable storage fails', async () => {
    services(); mount(<AuroraPayment/>); const user = await fill();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw Error('Storage is unavailable'); });
    await user.click(screen.getByRole('checkbox')); await user.click(screen.getByRole('button', { name: 'Save and show funding instructions' }));
    await screen.findByText('Storage is unavailable'); expect(screen.queryByTitle('Base mainnet USDC transfer request')).toBeNull();
  });
  it('blocks expired quotes and leaves funded records recoverable after expiry', async () => {
    const f = services(); f.quote.expiresAt = new Date(Date.now() - 1000).toISOString();
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ version: 1, reviewed: true, quote: f.quote })); mount(<AuroraPayment/>);
    await screen.findByText('Awaiting deposit'); expect(screen.queryByTitle('Base mainnet USDC transfer request')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review Aurora quote' })).toBeNull();
    expect(screen.getByText(/funding window is closed/)).toBeTruthy();
  });
  it.each(['PROCESSING', 'INCOMPLETE_DEPOSIT', 'FAILED', 'UNKNOWN'] as const)('does not expose another deposit or retry for %s', async status => {
    const f = services(); f.status.mockResolvedValue(makeStatus(f.quote, status));
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ version: 1, reviewed: true, quote: f.quote })); mount(<AuroraPayment/>);
    await waitFor(() => expect(f.status).toHaveBeenCalled());
    expect(screen.queryByTitle('Base mainnet USDC transfer request')).toBeNull(); expect(screen.queryByRole('button', { name: 'Review Aurora quote' })).toBeNull();
  });
  it('retains recovery on a provider timeout and refuses a status for a changed recipient', async () => {
    const f = services(); f.status.mockRejectedValueOnce(Error('Provider timeout')).mockResolvedValueOnce(makeStatus({ ...f.quote, recipient: other }));
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ version: 1, reviewed: true, quote: f.quote })); mount(<AuroraPayment/>);
    await screen.findByText('Provider timeout');
    await userEvent.click(screen.getByRole('button', { name: 'Check existing swap status' }));
    await screen.findByText(/Status does not match the reviewed quote/);
    expect(localStorage.getItem(RECOVERY_KEY)).toBeTruthy(); expect(screen.queryByTitle('Base mainnet USDC transfer request')).toBeNull();
  });
  it('keeps funding disabled while capability errors have an accessible retry', async () => {
    const f = services(); f.capabilities.mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce({ enabled: false, statusAvailable: true, network: 'MAINNET' });
    mount(<AuroraPayment/>); await screen.findByText('Unable to check Aurora availability.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry availability check' }));
    await screen.findByText(/Aurora funding is not enabled/); expect(f.preview).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Review Aurora quote' })).toHaveProperty('disabled', true);
  });
  it('does not overwrite an existing swap created by another tab during review', async () => {
    services(); mount(<AuroraPayment/>); const user = await fill();
    const otherQuote = { ...makeQuote(), depositAddress: refundTo };
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ version: 1, reviewed: true, quote: otherQuote }));
    await user.click(screen.getByRole('checkbox')); await user.click(screen.getByRole('button', { name: 'Save and show funding instructions' }));
    await screen.findByText(/Another tab saved a swap/); expect(JSON.parse(localStorage.getItem(RECOVERY_KEY)!).quote.depositAddress).toBe(refundTo);
  });
  it('persists manual recovery as status-only and cannot fund it after a reload', async () => {
    const f = services(), view = mount(<AuroraPayment/>), user = userEvent.setup();
    await user.click(screen.getByText('Recover an existing swap'));
    await user.type(screen.getByLabelText('Original Base deposit address'), depositAddress);
    await user.click(screen.getByRole('button', { name: 'Recover status only' }));
    await screen.findByText('Recovered for status checks only. Do not send another deposit.');
    expect(JSON.parse(localStorage.getItem(RECOVERY_KEY)!).reviewed).toBe(false);
    view.unmount(); mount(<AuroraPayment/>);
    await screen.findByText('Awaiting deposit');
    expect(screen.queryByTitle('Base mainnet USDC transfer request')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review Aurora quote' })).toBeNull();
    expect(f.preview).not.toHaveBeenCalled();
  });
  it('renders mainnet receipt links only after provider status and keeps them separate from XLM history', async () => {
    const f = services(); f.status.mockResolvedValue({ ...makeStatus(f.quote, 'SUCCESS'), destinationTxHashes: ['a'.repeat(64)], amountOut: '98000001' });
    localStorage.setItem(RECOVERY_KEY, JSON.stringify({ version: 1, reviewed: true, quote: f.quote })); mount(<AuroraPayment/>);
    const receipt = await screen.findByRole('link', { name: 'Stellar mainnet receipt' });
    expect(receipt.getAttribute('href')).toBe('https://stellar.expert/explorer/public/tx/' + 'a'.repeat(64));
    expect(screen.getByText(/Cherry has not independently verified Stellar settlement/)).toBeTruthy();
  });
});
describe('recipient intelligence remains read-only', () => {
  it('makes a single GET on explicit check, reports unsupported coverage, and clears on edits', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...coverage(), network: 'TESTNET' })); vi.stubGlobal('fetch', fetcher);
    const user = userEvent.setup(); mount(<RecipientIntelligence/>);
    await user.type(screen.getByLabelText('Stellar recipient address'), recipient); expect(fetcher).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Check recipient intelligence' }));
    await screen.findByRole('heading', { name: 'No Nansen assessment available' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
    expect(String(fetcher.mock.calls[0][0])).toContain('/api/v1/intelligence/recipient?');
    expect(String(fetcher.mock.calls[0][0])).toContain('network=TESTNET');
    expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/apikey|signTransaction|aurora\/quotes/);
    await user.selectOptions(screen.getByLabelText('Stellar network'), 'MAINNET');
    expect(screen.queryByRole('heading', { name: 'No Nansen assessment available' })).toBeNull();
  });
  it('discards an in-flight result after the address changes', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolve = r; })));
    const user = userEvent.setup(); mount(<RecipientIntelligence/>);
    await user.type(screen.getByLabelText('Stellar recipient address'), recipient); await user.click(screen.getByRole('button', { name: 'Check recipient intelligence' }));
    await user.clear(screen.getByLabelText('Stellar recipient address')); resolve(Response.json(coverage()));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check recipient intelligence' }).textContent).toBe('Check recipient intelligence'));
    expect(screen.queryByRole('heading', { name: 'No Nansen assessment available' })).toBeNull();
  });
  it('refuses another address or chain and never interprets an empty result as safe', async () => {
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher);
    for (const body of [coverage(other), { ...coverage(), chain: 'monad' }, {}, { ...coverage(), status: 'safe' }]) {
      fetcher.mockResolvedValueOnce(Response.json(body)); await expect(loadRecipientIntelligence(recipient, 'MAINNET')).rejects.toThrow('Unexpected');
    }
    await expect(loadRecipientIntelligence('0x1234', 'MAINNET')).rejects.toThrow('valid Stellar'); expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
describe('quote protocol validation', () => {
  it('uses 6 decimals for Base and 7 for Stellar without floating-point rounding', () => {
    expect(inputAmount('10.000001')).toBe('10000001'); expect(units('100000001', 7)).toBe('10.0000001'); expect(units('0', 7)).toBe('0');
    for (const value of ['1e2', '100.000001', '0.0000001', '0', '-1']) expect(() => inputAmount(value)).toThrow();
  });
  it('rejects wrong tokens, wrong networks and impossible minimums', () => {
    for (const changed of [{ network: 'TESTNET' }, { sourceAsset: STELLAR_USDC }, { minAmountOut: '100000000000' }, { amountIn: '1e7' }, { slippageBps: 200 }, { refundFee: '-1' }]) expect(() => decodeQuote({ ...makeQuote(), ...changed })).toThrow();
  });
});
