import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PaymentError, requireThat } from '../payments/model.js';
import type { PaymentDependencies } from '../payments/routes.js';
import { PayrollService, type PayRunInput, type PayRunStore } from './service.js';
const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
const reference = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' };
const amount = { type: 'string', pattern: '^[1-9][0-9]{0,18}$' };
export const payRunSchema = { type: 'object', additionalProperties: false, required: ['network','reference','maxFeeStroops','items'], properties: {
  network: { type: 'string', const: 'TESTNET' }, reference, maxFeeStroops: amount,
  items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['reference','destination','amountStroops'], properties: { reference, destination: { type: 'string', minLength: 56, maxLength: 56 }, amountStroops: amount } } },
} };
export async function registerPayrollRoutes(app: FastifyInstance, deps?: PaymentDependencies, store?: PayRunStore) {
  const service = deps ? new PayrollService(deps.service, store) : undefined;
  await app.register(async scope => {
    const owners = new WeakMap<FastifyRequest, string>();
    scope.addHook('onRequest', async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!deps) return reply.code(503).send({ error: 'PAYMENT_INTEGRATION_NOT_CONFIGURED' });
      if (req.method !== 'GET' && req.headers.origin !== deps.origin) return reply.code(403).send({ error: 'UNTRUSTED_ORIGIN' });
      const principal = await deps.authenticate(req);
      if (!principal) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
      owners.set(req, principal.subject);
    });
    scope.setErrorHandler((e, _req, reply) => reply.code(e instanceof PaymentError ? e.status : e.validation ? 400 : 503).send({ error: e instanceof PaymentError ? e.code : e.validation ? 'INVALID_REQUEST' : 'PAYROLL_SERVICE_UNAVAILABLE' }));
    const params = (names: string[]) => ({ type: 'object', additionalProperties: false, required: names, properties: Object.fromEntries(names.map(n => [n, n === 'lineReference' ? reference : id])) });
    const context = (req: FastifyRequest) => { requireThat(service && owners.has(req), 'AUTHENTICATION_REQUIRED', 401); return { owner: owners.get(req)!, ...(req.params as { walletId: string; runId: string; lineReference: string }) }; };
    const base = '/api/v1/wallets/:walletId/payroll';
    scope.post(base, { schema: { params: params(['walletId']), body: payRunSchema } }, async req => { const c = context(req); return service!.create(c.owner, c.walletId, req.body as PayRunInput); });
    scope.get(base, { schema: { params: params(['walletId']), querystring: { type: 'object', additionalProperties: false, properties: { cursor: id } } } }, async req => { const c = context(req); return service!.list(c.owner, c.walletId, (req.query as { cursor?: string }).cursor); });
    scope.get(`${base}/:runId`, { schema: { params: params(['walletId','runId']) } }, async req => { const c = context(req); return service!.get(c.owner, c.walletId, c.runId); });
    scope.post(`${base}/:runId/lines/:lineReference/prepare`, { schema: { params: params(['walletId','runId','lineReference']), body: { type: 'object', additionalProperties: false } } }, async (req, reply) => { const c = context(req); reply.code(202); return service!.prepareLine(c.owner, c.walletId, c.runId, c.lineReference); });
  });
}
