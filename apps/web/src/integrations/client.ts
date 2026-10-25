import { StrKey } from '@stellar/stellar-sdk';

export const BASE_USDC_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
export const STELLAR_USDC = 'nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu';
export const RECOVERY_KEY = 'cherrypay:aurora:mainnet:v1';
export type AuroraInput = { recipient: string; refundTo: string; amount: string };
export type AuroraQuote = {
  provider: 'Aurora Intents'; network: 'MAINNET'; sourceAsset: string; destinationAsset: string;
  recipient: string; refundTo: string; amountIn: string; amountOut: string; minAmountOut: string;
  depositAddress: string; expiresAt: string; slippageBps: 100; refundFee: string | null; withdrawFee: string | null;
};
export type SwapStatus = { quote: AuroraQuote; status: 'PENDING_DEPOSIT' | 'INCOMPLETE_DEPOSIT' | 'PROCESSING' | 'SUCCESS' | 'REFUNDED' | 'FAILED' | 'UNKNOWN'; checkedAt: string; originTxHashes: string[]; destinationTxHashes: string[]; amountOut: string | null };
export type Capabilities = { enabled: boolean; statusAvailable: boolean; network: 'MAINNET' };
export type RecipientIntelligence = { provider: 'Nansen'; chain: 'stellar'; address: string; network: 'MAINNET' | 'TESTNET'; status: 'unsupported'; providerCalled: false; coverageVerifiedAt: string; message: string; notice: string };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Unexpected service response. Check the existing payment before funding.');
  return value as Record<string, unknown>;
}
export function isAtomic(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9]\d{0,30})$/.test(value); }
export function units(value: string, decimals: number): string {
  if (!isAtomic(value)) throw Error('Invalid token amount.');
  const digits = value.padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`.replace(/\.?0+$/, '');
}
// Ported exact-amount validation and pilot cap from Monad-Metropolis aurora/plan.ts.
export function inputAmount(value: string): string {
  if (!/^(0|[1-9]\d{0,3})(\.\d{1,6})?$/.test(value)) throw Error('Enter a USDC amount with no more than 6 decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (amount <= 0n || amount > 100_000_000n) throw Error('This pilot supports more than zero and at most 100 USDC.');
  return amount.toString();
}
export function evmAddress(value: unknown): value is string { return typeof value === 'string' && /^0x[\da-fA-F]{40}$/.test(value) && !/^0x0{40}$/i.test(value) && value.toLowerCase() !== BASE_USDC_CONTRACT; }
export function validateInput(input: AuroraInput) {
  if (!StrKey.isValidEd25519PublicKey(input.recipient)) throw Error('Enter a Stellar mainnet G-address. Contract, muxed and memo-required destinations are unsupported.');
  if (!evmAddress(input.refundTo)) throw Error('Enter your Base wallet address for refunds.');
  inputAmount(input.amount);
}
export function decodeQuote(value: unknown): AuroraQuote {
  const q = object(value);
  if (q.provider !== 'Aurora Intents' || q.network !== 'MAINNET' || q.sourceAsset !== BASE_USDC || q.destinationAsset !== STELLAR_USDC || typeof q.recipient !== 'string' || !StrKey.isValidEd25519PublicKey(q.recipient) || !evmAddress(q.refundTo) || !evmAddress(q.depositAddress) || q.slippageBps !== 100 || typeof q.expiresAt !== 'string' || !Number.isFinite(Date.parse(q.expiresAt))) throw Error('The quote has an unsupported route or destination.');
  for (const key of ['amountIn', 'amountOut', 'minAmountOut']) if (!isAtomic(q[key]) || BigInt(q[key]) <= 0n) throw Error('The quote has an invalid amount.');
  for (const key of ['refundFee', 'withdrawFee']) if (q[key] !== null && !isAtomic(q[key])) throw Error('The quote has an invalid fee.');
  if (BigInt(q.amountIn as string) > 100_000_000n || BigInt(q.minAmountOut as string) > BigInt(q.amountOut as string) || BigInt(q.minAmountOut as string) < BigInt(q.amountOut as string) * 99n / 100n) throw Error('The quote exceeds the pilot or slippage limits.');
  return q as unknown as AuroraQuote;
}
export function assertFresh(quote: AuroraQuote) {
  if (Date.parse(quote.expiresAt) <= Date.now() + 30_000) throw Error('The funding window is closed or nearly expired. Do not fund this quote.');
}
export function sameQuote(a: AuroraQuote, b: AuroraQuote) {
  return (['recipient', 'refundTo', 'amountIn', 'amountOut', 'minAmountOut', 'depositAddress', 'expiresAt', 'slippageBps', 'refundFee', 'withdrawFee'] as const).every(k => a[k] === b[k]);
}
export async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try { response = await fetch(`/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) }); }
  catch { throw Error('Connection unavailable. If you already funded a swap, check its status before starting another.'); }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw Error(result && typeof object(result).error === 'string' ? String(object(result).error) : 'Service unavailable. Try again later.');
  return result;
}
export const auroraClient = {
  async capabilities(signal?: AbortSignal): Promise<Capabilities> {
    const r = object(await request('aurora/capabilities', undefined, signal));
    if (typeof r.enabled !== 'boolean' || typeof r.statusAvailable !== 'boolean' || r.network !== 'MAINNET') throw Error('Unable to verify Aurora availability.');
    return r as unknown as Capabilities;
  },
  async quote(input: AuroraInput): Promise<AuroraQuote> {
    validateInput(input);
    const q = decodeQuote(await request('aurora/quotes', input));
    if (q.recipient !== input.recipient || q.refundTo.toLowerCase() !== input.refundTo.toLowerCase() || q.amountIn !== inputAmount(input.amount)) throw Error('The quote differs from your request.');
    assertFresh(q); return q;
  },
  async status(address: string): Promise<SwapStatus> {
    if (!evmAddress(address)) throw Error('Enter the Base deposit address from your quote.');
    const r = object(await request(`aurora/status?depositAddress=${encodeURIComponent(address)}`)), quote = decodeQuote(r.quote);
    if (quote.depositAddress.toLowerCase() !== address.toLowerCase() || !['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED', 'UNKNOWN'].includes(String(r.status)) || typeof r.checkedAt !== 'string' || !Number.isFinite(Date.parse(r.checkedAt))) throw Error('Unable to match this status to your deposit.');
    for (const [key, regex] of [['originTxHashes', /^0x[\da-fA-F]{64}$/], ['destinationTxHashes', /^[\da-fA-F]{64}$/]] as const) if (!Array.isArray(r[key]) || !(r[key] as unknown[]).every(h => typeof h === 'string' && regex.test(h))) throw Error('Unexpected transaction reference.');
    if (r.amountOut !== null && !isAtomic(r.amountOut)) throw Error('Unexpected destination amount.');
    return { ...r, quote } as SwapStatus;
  },
};
export async function loadRecipientIntelligence(address: string, network: 'MAINNET' | 'TESTNET', signal?: AbortSignal): Promise<RecipientIntelligence> {
  const normalized = address.trim();
  if (!StrKey.isValidEd25519PublicKey(normalized) && !StrKey.isValidContract(normalized)) throw Error('Enter a valid Stellar G-address or C-address.');
  const r = object(await request(`intelligence/recipient?address=${encodeURIComponent(normalized)}&network=${network}`, undefined, signal));
  // Adapted from Monad-Metropolis nansen/client.ts; bind every result to the request.
  if (r.provider !== 'Nansen' || r.chain !== 'stellar' || r.address !== normalized || r.network !== network || r.status !== 'unsupported' || r.providerCalled !== false || typeof r.message !== 'string' || typeof r.notice !== 'string' || typeof r.coverageVerifiedAt !== 'string') throw Error('Unexpected recipient-intelligence response. No assessment is available.');
  return r as unknown as RecipientIntelligence;
}
