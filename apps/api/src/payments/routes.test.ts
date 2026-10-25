import Fastify from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryRepository } from './test-support/memory-repository.js';
import { PaymentService } from './service.js';
import { registerPaymentRoutes } from './routes.js';
import { intent, mockChain, mockPolicy, wallet } from './test-fixtures.js';
let store: MemoryRepository;
beforeEach(() => { store = new MemoryRepository(); store.register(wallet); });
async function app(subject: string | null = 'alice') {
  const server = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } }); const service = new PaymentService(store, mockChain(), mockPolicy(), 1);
  await registerPaymentRoutes(server, { service, origin: 'https://wallet.example', authenticate: async () => subject ? { subject } : null }); return server;
}
const path = '/api/v1/wallets/wallet-1/attempts';
const headers = { origin: 'https://wallet.example', 'idempotency-key': 'idempotency-key-0001' };
describe('authenticated payment API schemas', () => {
  it('fails closed without a verified integration', async () => { const server = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } }); await registerPaymentRoutes(server); expect((await server.inject({ url: path })).statusCode).toBe(503); await server.close(); });
  it('requires identity, ownership and exact origin', async () => {
    for (const [subject, expected] of [[null, 401], ['bob', 404]] as const) { const server = await app(subject); expect((await server.inject({ url: path })).statusCode).toBe(expected); await server.close(); }
    const server = await app(); expect((await server.inject({ method: 'POST', url: path, headers: { ...headers, origin: 'https://evil.example' }, payload: intent })).statusCode).toBe(403); await server.close();
  });
  it('validates requests, enforces idempotency and omits private backend fields', async () => {
    const server = await app();
    expect((await server.inject({ method: 'POST', url: path, headers, payload: { ...intent, signedXdr: 'evil' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: path, headers: { origin: headers.origin }, payload: intent })).statusCode).toBe(400);
    const response = await server.inject({ method: 'POST', url: path, headers, payload: intent }); expect(response.statusCode).toBe(202);
    const body = response.json(); expect(body.status).toBe('awaiting_approval'); for (const field of ['signedXdr', 'prepared', 'idempotencyKey', 'policy', 'leaseToken']) expect(body).not.toHaveProperty(field);
    expect((await server.inject({ url: `${path}/${body.id}` })).json().id).toBe(body.id);
    expect((await server.inject({ method: 'POST', url: path, headers, payload: { ...intent, amountStroops: '2' } })).statusCode).toBe(409);
    await server.close();
  });
});

it('advertises approval capability only when configured and fails closed on begin/finish',async()=>{
  const server=await app();
  try {
    expect((await server.inject({url:'/api/v1/wallets/wallet-1'})).json().approvalMode).toBe('external');
    const created=await server.inject({method:'POST',url:path,headers,payload:intent});const id=created.json().id;
    const result=await server.inject({method:'POST',url:`${path}/${id}/approval/options`,headers,payload:{}});
    expect(result.statusCode).toBe(503);expect(result.json().error).toBe('PASSKEY_APPROVAL_NOT_CONFIGURED');
    const malformed=await server.inject({method:'POST',url:`${path}/${id}/approval/verify`,headers,payload:{requestID:'x',response:{}}});
    expect(malformed.statusCode).toBe(400);
  } finally {await server.close();}
});
