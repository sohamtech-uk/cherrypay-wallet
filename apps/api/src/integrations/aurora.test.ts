import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { StrKey } from '@stellar/stellar-sdk';
import { AuroraService, BASE_USDC, STELLAR_USDC, USDC_ISSUER, validateInput } from './aurora.js';
import { integrationConfig, registerIntegrationRoutes } from './routes.js';

const recipient = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const refundTo = `0x${'1'.repeat(40)}`, depositAddress = `0x${'2'.repeat(40)}`;
const input = { recipient, refundTo, amount: '10.000001' };
const now = Date.parse('2026-10-25T12:00:00Z');
const deadline = new Date(now + 15 * 60_000).toISOString();
function quote() { return { quoteRequest: { dry: false, swapType: 'EXACT_INPUT', depositType: 'ORIGIN_CHAIN', recipientType: 'DESTINATION_CHAIN', refundType: 'ORIGIN_CHAIN', originAsset: BASE_USDC, destinationAsset: STELLAR_USDC, amount: '10000001', recipient, refundTo, slippageTolerance: 100, deadline }, quote: { amountIn: '10000001', amountOut: '98000000', minAmountOut: '97020000', depositAddress, deadline, timeWhenInactive: deadline, refundFee: '10000', withdrawFee: '100000' } }; }
function account() { return { account_id: recipient, data: {}, balances: [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, is_authorized: true, balance: '1.0000000', buying_liabilities: '0.0000000', limit: '922337203685.4775807' }] }; }
const tokens = [{ assetId: BASE_USDC, blockchain: 'base', symbol: 'USDC', decimals: 6 }, { assetId: STELLAR_USDC, blockchain: 'stellar', symbol: 'USDC', decimals: 7 }];
function fixture() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => Response.json(String(url).includes('/tokens/') ? { tokens, asset_stats: [] } : String(url).includes('horizon.stellar.org') ? account() : quote()));
  return { fetcher, service: new AuroraService('test-key-not-real', fetcher, () => now) };
}
describe('Aurora exact-input Stellar route', () => {
  it('uses only the approved provider, assets, mainnet account and exact atomic amounts', async () => {
    const { service, fetcher } = fixture();
    const result = await service.quote(input);
    expect(result).toMatchObject({ network: 'MAINNET', amountIn: '10000001', amountOut: '98000000', minAmountOut: '97020000', recipient, refundTo });
    const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(post[0]).toBe('https://intents-api.aurora.dev/api/quote/test-key-not-real');
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({ dry: false, depositMode: 'SIMPLE', amount: '10000001', recipient, slippageTolerance: 100, deadline });
    expect(fetcher.mock.calls.every(([url]) => !/submit|sendTransaction|execute/.test(String(url)))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('test-key');
  });
  it.each(['0', '-1', '1e1', '0.0000001', '100.000001', '01', 'NaN'])('rejects unsafe or rounded amount %s before any provider call', async amount => {
    const { service, fetcher } = fixture(); await expect(service.quote({ ...input, amount })).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([USDC_ISSUER, StrKey.encodeContract(Buffer.alloc(32, 1)), 'M' + 'A'.repeat(68), recipient.slice(0, -1) + 'A'])('rejects unsupported recipient %s', recipient => { expect(() => validateInput({ ...input, recipient })).toThrow(); });
  it('fails closed when the live catalog changes or advertises the wrong decimals', async () => {
    const { service, fetcher } = fixture(); fetcher.mockResolvedValueOnce(Response.json({ tokens: [{ ...tokens[0] }, { ...tokens[1], decimals: 6 }] }));
    await expect(service.quote(input)).rejects.toThrow('not currently advertising'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(['missing', 'unauthorized', 'memo', 'capacity'])('rejects %s trustline eligibility without creating a quote', async condition => {
    const { service, fetcher } = fixture(), a = account();
    if (condition === 'missing') a.balances = [];
    if (condition === 'unauthorized') a.balances[0].is_authorized = false;
    if (condition === 'memo') a.data = { 'config.memo_required': 'MQ==' };
    if (condition === 'capacity') a.balances[0].limit = '2.0000000';
    fetcher.mockResolvedValueOnce(Response.json({ tokens, asset_stats: [] })).mockResolvedValueOnce(Response.json(a));
    await expect(service.quote(input)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['recipient', 'refund', 'amount', 'asset', 'expiry', 'minimum', 'memo'])('rejects a mismatched %s quote', async field => {
    const { service, fetcher } = fixture(), q = quote();
    if (field === 'recipient') q.quoteRequest.recipient = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));
    if (field === 'refund') q.quoteRequest.refundTo = depositAddress;
    if (field === 'amount') q.quote.amountIn = '10000000';
    if (field === 'asset') q.quoteRequest.destinationAsset = BASE_USDC;
    if (field === 'expiry') q.quote.deadline = new Date(now - 1).toISOString();
    if (field === 'minimum') q.quote.minAmountOut = '90000000';
    if (field === 'memo') Object.assign(q.quote, { depositMemo: 'required' });
    fetcher.mockResolvedValueOnce(Response.json({ tokens, asset_stats: [] })).mockResolvedValueOnce(Response.json(account())).mockResolvedValueOnce(Response.json(q));
    await expect(service.quote(input)).rejects.toThrow();
  });
  it('redacts upstream errors including credentials and handles timeouts and throttles', async () => {
    for (const error of [Error('https://upstream/test-key-not-real'), new DOMException('timeout', 'TimeoutError')]) {
      const { service, fetcher } = fixture(); fetcher.mockRejectedValue(error);
      await expect(service.quote(input)).rejects.toThrow('Provider connection unavailable');
    }
    const { service, fetcher } = fixture(); fetcher.mockResolvedValue(new Response('', { status: 429 }));
    await expect(service.quote(input)).rejects.toThrow('rate limit');
  });
  it('binds status to the deposit and converts unknown statuses to uncertain outcomes', async () => {
    const { service, fetcher } = fixture(); fetcher.mockImplementation(async () => Response.json({ quoteResponse: quote(), status: 'NEW_PROVIDER_STATE', swapDetails: {} }));
    expect((await service.status(depositAddress)).status).toBe('UNKNOWN');
    await expect(service.status(refundTo)).rejects.toThrow('another deposit');
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('returns only valid receipt hashes and the exact actual output', async () => {
    const { service, fetcher } = fixture();
    fetcher.mockResolvedValue(Response.json({ quoteResponse: quote(), status: 'SUCCESS', swapDetails: { amountOut: '98000001', originChainTxHashes: [{ hash: '0x' + 'a'.repeat(64), explorerUrl: 'javascript:bad' }], destinationChainTxHashes: [{ hash: 'b'.repeat(64) }, { hash: 'bad' }] } }));
    expect(await service.status(depositAddress)).toMatchObject({ status: 'SUCCESS', amountOut: '98000001', originTxHashes: ['0x' + 'a'.repeat(64)], destinationTxHashes: ['b'.repeat(64)] });
  });
});
describe('integration HTTP boundaries', () => {
  it('blocks mainnet quotes on the default Testnet deployment even with a key and enable flag', async () => {
    const app = Fastify(), fetcher = vi.fn<typeof fetch>();
    await registerIntegrationRoutes(app, integrationConfig({ AURORA_INTENTS_ENABLED: 'true', AURORA_INTENTS_API_KEY: 'key' }), fetcher);
    try {
      expect((await app.inject('/api/v1/aurora/capabilities')).json()).toMatchObject({ enabled: false, supported: false, network: 'TESTNET' });
      const response = await app.inject({ method: 'POST', url: '/api/v1/aurora/quotes', payload: input });
      expect(response.statusCode).toBe(503); expect(response.json().code).toBe('AURORA_TESTNET_UNSUPPORTED'); expect(fetcher).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('requires both the explicit mainnet gate and the server key, and never publishes the key', async () => {
    for (const config of [integrationConfig({}), integrationConfig({ AURORA_INTENTS_NETWORK: 'MAINNET', AURORA_INTENTS_ENABLED: 'true' }), integrationConfig({ AURORA_INTENTS_NETWORK: 'MAINNET', AURORA_INTENTS_API_KEY: 'private-key' })]) {
      const app = Fastify(), fetcher = vi.fn<typeof fetch>(); await registerIntegrationRoutes(app, config, fetcher);
      try {
        const capabilities = await app.inject('/api/v1/aurora/capabilities'); expect(capabilities.json().enabled).toBe(false); expect(capabilities.body).not.toContain('private-key');
        expect((await app.inject({ method: 'POST', url: '/api/v1/aurora/quotes', payload: input })).statusCode).toBe(503); expect(fetcher).not.toHaveBeenCalled();
      } finally { await app.close(); }
    }
  });
  it('requires an explicit mainnet network before the enabled route can call Aurora', async () => {
    const app = Fastify(), { fetcher } = fixture();
    await registerIntegrationRoutes(app, integrationConfig({ AURORA_INTENTS_NETWORK: 'MAINNET', AURORA_INTENTS_ENABLED: 'true', AURORA_INTENTS_API_KEY: 'key' }), fetcher);
    try {
      expect((await app.inject('/api/v1/aurora/capabilities')).json()).toMatchObject({ enabled: true, supported: true, network: 'MAINNET' });
      // Invalid input is rejected before provider access, even on an enabled route.
      expect((await app.inject({ method: 'POST', url: '/api/v1/aurora/quotes', payload: { ...input, amount: '1e2' } })).statusCode).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('permits read-only status recovery while new quotes are disabled', async () => {
    const app = Fastify(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ quoteResponse: quote(), status: 'REFUNDED' }));
    await registerIntegrationRoutes(app, { auroraEnabled: false, auroraApiKey: 'key' }, fetcher);
    try { expect((await app.inject(`/api/v1/aurora/status?depositAddress=${depositAddress}`)).json().status).toBe('REFUNDED'); } finally { await app.close(); }
  });
  it('does not call Nansen, signers or payment services for a valid Stellar coverage check', async () => {
    const app = Fastify(), fetcher = vi.fn<typeof fetch>(); await registerIntegrationRoutes(app, integrationConfig({}), fetcher);
    try {
      const result = await app.inject(`/api/v1/intelligence/recipient?address=${recipient}&network=MAINNET`);
      expect(result.json()).toMatchObject({ providerCalled: false, status: 'unsupported', address: recipient, network: 'MAINNET' }); expect(fetcher).not.toHaveBeenCalled();
      expect((await app.inject(`/api/v1/intelligence/recipient?address=${refundTo}&network=MAINNET`)).statusCode).toBe(400);
      expect((await app.inject(`/api/v1/intelligence/recipient?address=${recipient}&network=monad`)).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/v1/intelligence/recipient', payload: input })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
