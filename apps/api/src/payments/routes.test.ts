import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PasskeyApprovalService } from './passkey-approval.js';
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

it('discovers only session-owned wallets and rejects an owner supplied in the query',async()=>{
  store.register({...wallet,id:'bob-wallet',owner:'bob'});
  const server=await app();
  try {
    const result=await server.inject({url:'/api/v1/wallets'});
    expect(result.json()).toEqual({network:'TESTNET',items:[{id:wallet.id,address:wallet.address,network:'TESTNET'}]});
    expect(result.headers['cache-control']).toBe('no-store');
    expect((await server.inject({url:'/api/v1/wallets?owner=bob'})).statusCode).toBe(400);
  } finally {await server.close();}
  const unauthenticated=await app(null);
  expect((await unauthenticated.inject({url:'/api/v1/wallets'})).statusCode).toBe(401);await unauthenticated.close();
});
it('cannot bypass the WebAuthn ticket verifier through the raw approval endpoint',async()=>{
  const chain=mockChain(),service=new PaymentService(store,chain,mockPolicy(),1),server=Fastify();
  const approve=vi.spyOn(service,'approve');
  await registerPaymentRoutes(server,{service,origin:headers.origin,authenticate:async()=>({subject:wallet.owner,sessionHash:'session'}),approvals:{} as PasskeyApprovalService});
  try {
    const result=await server.inject({method:'POST',url:`${path}/attempt-1/approve`,headers,payload:{authXdr:'AAAA'}});
    expect(result.statusCode).toBe(403);expect(result.json().error).toBe('EXTERNAL_APPROVAL_DISABLED');
    expect(approve).not.toHaveBeenCalled();expect(chain.authorize).not.toHaveBeenCalled();expect(chain.submit).not.toHaveBeenCalled();
  } finally {await server.close();}
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

it('only queries the indexer after session ownership checks and never labels its data verified',async()=>{
  const indexer={account:vi.fn(async(address:string)=>({address,nativeXlmStroops:'999',transactions:[],previousCursor:null,hasPreviousPage:false,balancesTruncated:false}))};
  for(const [subject,status] of [[null,401],['bob',404],['alice',200]] as const) {
    const server=Fastify(), service=new PaymentService(store,mockChain(),mockPolicy(),1);
    await registerPaymentRoutes(server,{service,indexer,origin:headers.origin,authenticate:async()=>subject?{subject}:null});
    const result=await server.inject({url:'/api/v1/wallets/wallet-1/indexed'});
    expect(result.statusCode).toBe(status);
    if(status===200)expect(result.json()).toMatchObject({verified:false,source:'wallet-backend',account:{address:wallet.address}});
    else expect(indexer.account).not.toHaveBeenCalled();
    await server.close();
  }
  expect(indexer.account).toHaveBeenCalledTimes(1);
  expect(indexer.account).toHaveBeenCalledWith(wallet.address);
});

it('activates only the authenticated owner and refreshes balance from the chain',async()=>{
  const chain=mockChain(),ensureOwnerWallet=vi.fn(async()=>{}),server=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});
  const service=new PaymentService(store,chain,mockPolicy(),1);
  await registerPaymentRoutes(server,{service,origin:headers.origin,authenticate:async()=>({subject:wallet.owner}),ensureOwnerWallet});
  await store.setBalance(wallet.address,'0',90);
  vi.mocked(chain.balance).mockResolvedValue({amountStroops:'100000000000',ledger:101});
  try {
    expect((await server.inject({url:'/api/v1/wallets?owner=bob'})).statusCode).toBe(400);
    expect(ensureOwnerWallet).not.toHaveBeenCalled();
    expect((await server.inject({url:'/api/v1/wallets'})).statusCode).toBe(200);
    expect(ensureOwnerWallet).toHaveBeenCalledWith(wallet.owner);
    expect((await server.inject({url:'/api/v1/wallets/wallet-1/balance'})).json()).toMatchObject({snapshot:{amountStroops:'100000000000',ledger:101}});
    expect(chain.balance).toHaveBeenCalledWith(wallet.address);
  } finally {await server.close();}
});
