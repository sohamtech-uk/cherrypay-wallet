import type { FastifyInstance } from 'fastify';
import { StrKey } from '@stellar/stellar-sdk';
import { AuroraService, IntegrationError, type AuroraInput } from './aurora.js';

export type IntegrationConfig = { auroraEnabled: boolean; auroraApiKey: string };
export function integrationConfig(env: NodeJS.ProcessEnv = process.env): IntegrationConfig {
  return { auroraEnabled: env.AURORA_INTENTS_ENABLED === 'true', auroraApiKey: env.AURORA_INTENTS_API_KEY?.trim() ?? '' };
}
export async function registerIntegrationRoutes(app: FastifyInstance, config: IntegrationConfig, fetcher: typeof fetch = fetch) {
  const service = new AuroraService(config.auroraApiKey, fetcher);
  const enabled = config.auroraEnabled && !!config.auroraApiKey;
  // Bounded per-process limiter; status reads do not consume the quote budget.
  const limits = new Map<string, { count: number; until: number }>();
  const limited = (ip: string, kind: string, maximum: number) => {
    const now = Date.now();
    for (const [key, entry] of limits) if (entry.until <= now) limits.delete(key);
    const key = `${ip}:${kind}`, entry = limits.get(key);
    if (entry) return ++entry.count > maximum;
    if (limits.size >= 10_000) return true;
    limits.set(key, { count: 1, until: now + 60_000 }); return false;
  };
  app.get('/api/v1/aurora/capabilities', async () => ({ enabled, statusAvailable: !!config.auroraApiKey, network: 'MAINNET', route: 'Base USDC → Stellar USDC', maximumUsdc: '100', reason: enabled ? null : 'Aurora funding is not enabled for this deployment.' }));
  const text = { type: 'string', minLength: 1, maxLength: 100 };
  app.post<{ Body: AuroraInput }>('/api/v1/aurora/quotes', { schema: { body: { type: 'object', additionalProperties: false, required: ['recipient', 'refundTo', 'amount'], properties: { recipient: text, refundTo: text, amount: { ...text, maxLength: 30 } } } } }, async (req, reply) => {
    if (!enabled) return reply.code(503).send({ code: 'AURORA_DISABLED', error: 'Aurora funding is not enabled for this deployment.' });
    if (limited(req.ip, 'quote', 5)) return reply.header('Retry-After', '60').code(429).send({ error: 'Quote limit reached. Wait one minute.' });
    try { return await service.quote(req.body); }
    catch (e) { const error = e instanceof IntegrationError ? e : new IntegrationError('PROVIDER_UNAVAILABLE', 'Unable to verify the route. Do not fund an old quote.', 503); return reply.code(error.statusCode).send({ code: error.code, error: error.message }); }
  });
  app.get<{ Querystring: { depositAddress: string } }>('/api/v1/aurora/status', { schema: { querystring: { type: 'object', additionalProperties: false, required: ['depositAddress'], properties: { depositAddress: text } } } }, async (req, reply) => {
    if (!config.auroraApiKey) return reply.code(503).send({ error: 'Aurora status service is not configured. Keep your deposit address and try again later.' });
    if (limited(req.ip, 'status', 30)) return reply.header('Retry-After', '60').code(429).send({ error: 'Status limit reached. Wait one minute; do not fund again.' });
    try { return await service.status(req.query.depositAddress); }
    catch (e) { const error = e instanceof IntegrationError ? e : new IntegrationError('PROVIDER_UNAVAILABLE', 'Status is unavailable. Do not submit a replacement payment.', 503); return reply.code(error.statusCode).send({ code: error.code, error: error.message }); }
  });
  // Nansen's published Profiler chain enums do not include Stellar (verified 2026-10-25).
  // Do not send Stellar addresses to the Monad proxy or claim an empty result is clearance.
  app.get<{ Querystring: { address: string; network: string } }>('/api/v1/intelligence/recipient', { schema: { querystring: { type: 'object', additionalProperties: false, required: ['address', 'network'], properties: { address: text, network: { enum: ['MAINNET', 'TESTNET'] } } } } }, async (req, reply) => {
    if (!StrKey.isValidEd25519PublicKey(req.query.address) && !StrKey.isValidContract(req.query.address)) return reply.code(400).send({ error: 'Enter a valid Stellar G-address or C-address. Muxed and memo-based addresses are unsupported.' });
    return { provider: 'Nansen', chain: 'stellar', address: req.query.address, network: req.query.network, status: 'unsupported', providerCalled: false, coverageVerifiedAt: '2026-10-25', message: 'Nansen does not currently advertise Stellar recipient intelligence. No Nansen assessment was performed.', notice: 'Address syntax does not establish ownership, trustworthiness, sanctions status or payment eligibility.' };
  });
}
