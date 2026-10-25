import { StrKey } from '@stellar/stellar-sdk';

// Adapted from Monad-Metropolis apps/mobile/src/aurora/{config,plan,payment}.ts.
// Stellar uses Swap API delivery, not the Monad EVM execution recipe.
export const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
export const BASE_USDC_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const STELLAR_USDC = 'nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu';
export const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const API = 'https://intents-api.aurora.dev';
export class IntegrationError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}
export type AuroraInput = { recipient: string; refundTo: string; amount: string };
export type AuroraQuote = {
  provider: 'Aurora Intents'; network: 'MAINNET'; sourceAsset: typeof BASE_USDC;
  destinationAsset: typeof STELLAR_USDC; recipient: string; refundTo: string;
  amountIn: string; amountOut: string; minAmountOut: string; depositAddress: string;
  expiresAt: string; slippageBps: 100; refundFee: string | null; withdrawFee: string | null;
};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IntegrationError('INVALID_PROVIDER_RESPONSE', 'The provider returned an unexpected response. Check status before funding.', 502);
  return value as Record<string, unknown>;
}
function atomic(value: unknown, positive = true): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,30})$/.test(value) || (positive && BigInt(value) === 0n)) throw new IntegrationError('INVALID_PROVIDER_RESPONSE', 'The provider returned an invalid amount.', 502);
  return value;
}
export function evmAddress(value: unknown): value is string {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) && !/^0x0{40}$/i.test(value) && value.toLowerCase() !== BASE_USDC_CONTRACT;
}
export function parseAmount(value: string, decimals = 6): bigint {
  if (!new RegExp(`^(0|[1-9]\\d{0,12})(\\.\\d{1,${decimals}})?$`).test(value)) throw new IntegrationError('INVALID_AMOUNT', `Use a decimal amount with at most ${decimals} decimal places.`);
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
}
export function validateInput(input: AuroraInput): string {
  if (!StrKey.isValidEd25519PublicKey(input.recipient) || input.recipient === USDC_ISSUER) throw new IntegrationError('UNSUPPORTED_RECIPIENT', 'Use a funded Stellar mainnet G-address with a USDC trustline. Contract, muxed, issuer and memo-required destinations are unsupported.');
  if (!evmAddress(input.refundTo)) throw new IntegrationError('INVALID_REFUND_ADDRESS', 'Enter your Base wallet address for refunds, not a token contract or zero address.');
  const amount = parseAmount(input.amount);
  if (amount <= 0n || amount > 100_000_000n) throw new IntegrationError('INVALID_AMOUNT', 'This pilot supports more than zero and at most 100 USDC.');
  return amount.toString();
}

export class AuroraService {
  constructor(private key: string, private fetcher: typeof fetch = fetch, private now = Date.now) {}
  private async read(url: string, body?: unknown) {
    try {
      const response = await this.fetcher(url, { method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (!response.ok) throw new IntegrationError('PROVIDER_UNAVAILABLE', response.status === 429 ? 'Provider rate limit reached. Wait before checking again.' : 'The provider could not complete this request. Check the existing swap before funding.', 503);
      return await response.json() as unknown;
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      // Never return/log upstream URLs or errors: Aurora's key is part of the URL.
      throw new IntegrationError('PROVIDER_UNAVAILABLE', 'Provider connection unavailable. No payment was submitted by Cherry Wallet. Check the existing swap if you already funded it.', 503);
    }
  }
  private endpoint(path: string) { return `${API}/api/${path}/${encodeURIComponent(this.key)}`; }
  async checkRecipient(recipient: string, maximumStroops: bigint) {
    const account = object(await this.read(`https://horizon.stellar.org/accounts/${encodeURIComponent(recipient)}`));
    if (account.account_id !== recipient || !Array.isArray(account.balances)) throw new IntegrationError('RECIPIENT_UNAVAILABLE', 'Unable to verify this mainnet account.', 503);
    const data = account.data && object(account.data);
    if (data && Object.hasOwn(data, 'config.memo_required')) throw new IntegrationError('MEMO_REQUIRED', 'Memo-required destinations are unsupported. Use a personal Stellar account.');
    const trustline = account.balances.map(object).find(b => b.asset_type === 'credit_alphanum4' && b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER);
    if (!trustline || trustline.is_authorized !== true) throw new IntegrationError('USDC_TRUSTLINE_REQUIRED', 'The recipient needs an authorized Circle USDC trustline on Stellar mainnet.');
    const balance = parseAmount(String(trustline.balance), 7), limit = parseAmount(String(trustline.limit), 7), liabilities = parseAmount(String(trustline.buying_liabilities), 7);
    if (limit - balance - liabilities < maximumStroops) throw new IntegrationError('TRUSTLINE_LIMIT', 'The recipient does not have enough USDC trustline capacity for this payment.');
  }
  async quote(input: AuroraInput): Promise<AuroraQuote> {
    const amount = validateInput(input);
    const tokens = await this.read(this.endpoint('tokens'));
    if (!Array.isArray(tokens)) throw new IntegrationError('ROUTE_UNAVAILABLE', 'Unable to verify the supported route.', 503);
    const available = tokens.map(object);
    const supported = (assetId: string, blockchain: string, decimals: number) => available.some(t => t.assetId === assetId && t.blockchain === blockchain && t.symbol === 'USDC' && t.decimals === decimals);
    if (!supported(BASE_USDC, 'base', 6) || !supported(STELLAR_USDC, 'stellar', 7)) throw new IntegrationError('ROUTE_UNAVAILABLE', 'Aurora is not currently advertising Base USDC → Stellar USDC. Do not use an old deposit address.', 503);
    await this.checkRecipient(input.recipient, BigInt(amount) * 10n);
    const request = { dry: false, swapType: 'EXACT_INPUT', depositType: 'ORIGIN_CHAIN', depositMode: 'SIMPLE', originAsset: BASE_USDC, destinationAsset: STELLAR_USDC, amount, slippageTolerance: 100, recipient: input.recipient, recipientType: 'DESTINATION_CHAIN', refundTo: input.refundTo, refundType: 'ORIGIN_CHAIN', deadline: new Date(this.now() + 15 * 60_000).toISOString() };
    const result = this.normalizeQuote(await this.read(this.endpoint('quote'), request));
    if (result.recipient !== input.recipient || result.refundTo.toLowerCase() !== input.refundTo.toLowerCase() || result.amountIn !== amount || Date.parse(result.expiresAt) <= this.now() + 30_000 || Date.parse(result.expiresAt) > this.now() + 16 * 60_000) throw new IntegrationError('QUOTE_MISMATCH', 'The quote differs from your request or has expired. Request a new quote.', 502);
    // Output can differ from the input; validate the actual receive capacity too.
    await this.checkRecipient(input.recipient, BigInt(result.amountOut));
    return result;
  }
  normalizeQuote(value: unknown): AuroraQuote {
    const response = object(value), request = object(response.quoteRequest), quote = object(response.quote);
    if (request.dry !== false || request.swapType !== 'EXACT_INPUT' || request.depositType !== 'ORIGIN_CHAIN' || request.recipientType !== 'DESTINATION_CHAIN' || request.refundType !== 'ORIGIN_CHAIN' || request.originAsset !== BASE_USDC || request.destinationAsset !== STELLAR_USDC || request.slippageTolerance !== 100 || (request.depositMode !== undefined && request.depositMode !== 'SIMPLE') || (request.confidentiality !== undefined && request.confidentiality !== 'public') || request.virtualChainRecipient || request.virtualChainRefundRecipient || request.customRecipientMsg || quote.depositMemo) throw new IntegrationError('QUOTE_MISMATCH', 'The provider returned an unsupported route.', 502);
    if (typeof request.recipient !== 'string' || !StrKey.isValidEd25519PublicKey(request.recipient) || request.recipient === USDC_ISSUER || !evmAddress(request.refundTo) || !evmAddress(quote.depositAddress)) throw new IntegrationError('QUOTE_MISMATCH', 'The provider returned an unsupported destination.', 502);
    const amountIn = atomic(quote.amountIn), amountOut = atomic(quote.amountOut), minAmountOut = atomic(quote.minAmountOut);
    if (request.amount !== amountIn || BigInt(amountIn) > 100_000_000n || BigInt(minAmountOut) > BigInt(amountOut) || BigInt(minAmountOut) < BigInt(amountOut) * 99n / 100n) throw new IntegrationError('QUOTE_MISMATCH', 'The provider returned amounts outside the approved limits.', 502);
    const dates = [request.deadline, quote.deadline, ...(quote.timeWhenInactive === undefined ? [] : [quote.timeWhenInactive])].map(d => typeof d === 'string' ? Date.parse(d) : NaN);
    if (dates.some(d => !Number.isFinite(d))) throw new IntegrationError('QUOTE_MISMATCH', 'The quote has no valid expiry.', 502);
    return { provider: 'Aurora Intents', network: 'MAINNET', sourceAsset: BASE_USDC, destinationAsset: STELLAR_USDC, recipient: request.recipient, refundTo: request.refundTo, amountIn, amountOut, minAmountOut, depositAddress: quote.depositAddress, expiresAt: new Date(Math.min(...dates)).toISOString(), slippageBps: 100, refundFee: quote.refundFee == null ? null : atomic(quote.refundFee, false), withdrawFee: quote.withdrawFee == null ? null : atomic(quote.withdrawFee, false) };
  }
  async status(depositAddress: string) {
    if (!evmAddress(depositAddress)) throw new IntegrationError('INVALID_DEPOSIT', 'Enter the Base deposit address from the saved quote.');
    const result = object(await this.read(`${this.endpoint('status')}?depositAddress=${encodeURIComponent(depositAddress)}`));
    const quote = this.normalizeQuote(result.quoteResponse);
    if (quote.depositAddress.toLowerCase() !== depositAddress.toLowerCase()) throw new IntegrationError('STATUS_MISMATCH', 'The returned status belongs to another deposit.', 502);
    const known = ['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'];
    const status = typeof result.status === 'string' && known.includes(result.status) ? result.status : 'UNKNOWN';
    const details = result.swapDetails ? object(result.swapDetails) : {};
    // Provider explorer URLs are untrusted. Only return validated hashes; the UI builds links.
    function hashes(value: unknown, pattern: RegExp): string[] {
      if (!Array.isArray(value)) return [];
      return value.slice(0, 10).flatMap(v => { const hash = typeof v === 'string' ? v : object(v).hash; return typeof hash === 'string' && pattern.test(hash) ? [hash] : []; });
    }
    return { quote, status, checkedAt: new Date(this.now()).toISOString(), originTxHashes: hashes(details.originChainTxHashes, /^0x[\da-fA-F]{64}$/), destinationTxHashes: hashes(details.destinationChainTxHashes, /^[\da-fA-F]{64}$/), amountOut: details.amountOut === undefined ? null : atomic(details.amountOut, false) };
  }
}
