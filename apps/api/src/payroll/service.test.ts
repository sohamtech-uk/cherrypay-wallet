import { randomUUID } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { MemoryRepository } from '../payments/test-support/memory-repository.js';
import { PaymentService } from '../payments/service.js';
import { destination, intent, mockChain, mockPolicy, wallet } from '../payments/test-fixtures.js';
import { PayrollService, lineKey, payRunDigest, validatePayRun, type PayRun, type PayRunInput, type PayRunStore } from './service.js';
import { registerPayrollRoutes } from './routes.js';
const input: PayRunInput = { network:'TESTNET',reference:'2026-10',maxFeeStroops:'10000000',items:[{reference:'employee-1',destination,amountStroops:'10000001'}] };
function fixture() {
  const repository = new MemoryRepository(), chain = mockChain(), policy = mockPolicy();
  repository.register(wallet);
  const payments = new PaymentService(repository,chain,policy,1);
  const runs = new Map<string,PayRun>();
  const store: PayRunStore = {
    async create(walletId,payload) { let run = [...runs.values()].find(r => r.walletId === walletId && r.input.reference === payload.reference); if (!run) { run = { id:randomUUID(),walletId,input:structuredClone(payload),createdAt:Date.now(),requestDigest:payRunDigest(payload) }; runs.set(run.id,run); } return run; },
    async get(walletId,id) { const run = runs.get(id); if (!run || run.walletId !== walletId) throw Error('PAY_RUN_NOT_FOUND'); return run; },
    async list(walletId) { return [...runs.values()].filter(r => r.walletId === walletId); },
  };
  return { service:new PayrollService(payments,store),payments,repository,chain,policy,store,runs };
}
it('saves a draft without preparing, signing or submitting any payment', async () => {
  const f = fixture(), run = await f.service.create(wallet.owner,wallet.id,input);
  expect(run).toMatchObject({ status:'draft',totalStroops:'10000001',confirmedCount:0,items:[{attempt:null}] });
  expect(f.chain.prepare).not.toHaveBeenCalled(); expect(f.chain.authorize).not.toHaveBeenCalled(); expect(f.chain.submit).not.toHaveBeenCalled();
});
it('recovers the same line attempt after restart or timeout without replacement or approval', async () => {
  const f = fixture(), run = await f.service.create(wallet.owner,wallet.id,input);
  const first = await f.service.prepareLine(wallet.owner,wallet.id,run.id,'employee-1');
  const restarted = new PayrollService(f.payments,f.store);
  const second = await restarted.prepareLine(wallet.owner,wallet.id,run.id,'employee-1');
  expect(second.id).toBe(first.id); expect(f.chain.prepare).toHaveBeenCalledTimes(1); expect(f.chain.authorize).not.toHaveBeenCalled();
  expect((await restarted.get(wallet.owner,wallet.id,run.id)).items[0].attempt?.id).toBe(first.id);
  await f.payments.cancel(wallet.owner,wallet.id,first.id);
  expect((await restarted.prepareLine(wallet.owner,wallet.id,run.id,'employee-1')).status).toBe('rejected');
  expect(f.chain.prepare).toHaveBeenCalledTimes(1);
});
it('cannot expose another owner’s run or prepare its line', async () => {
  const f = fixture(), run = await f.service.create(wallet.owner,wallet.id,input);
  for (const action of [() => f.service.get('outsider',wallet.id,run.id),() => f.service.list('outsider',wallet.id),() => f.service.prepareLine('outsider',wallet.id,run.id,'employee-1')]) await expect(action()).rejects.toThrow('WALLET_NOT_FOUND');
  expect(f.chain.prepare).not.toHaveBeenCalled();
});
it('rejects duplicate recipients/references, wrong networks and overflow without rounding', () => {
  expect(validatePayRun({...input,items:[{...input.items[0],amountStroops:'9007199254740993'}]},wallet)).toBe('9007199254740993');
  for (const bad of [
    {...input,network:'MAINNET'}, {...input,items:[]}, {...input,items:[input.items[0],input.items[0]]},
    {...input,items:[input.items[0],{...input.items[0],reference:'employee-2'}]},
    {...input,items:[{...input.items[0],amountStroops:'9223372036854775807'},{reference:'b',destination:Keypair.random().publicKey(),amountStroops:'1'}]},
    {...input,maxFeeStroops:'10000001'}, {...input,items:[{...input.items[0],amountStroops:'1.2'}]},
  ]) expect(() => validatePayRun(bad as PayRunInput,wallet)).toThrow();
});
it('never treats pending/unknown attempts as completed or prepares other lines implicitly', async () => {
  const f = fixture(), run = await f.service.create(wallet.owner,wallet.id,input);
  const a = await f.service.prepareLine(wallet.owner,wallet.id,run.id,'employee-1');
  await f.payments.approve(wallet.owner,wallet.id,a.id,'signed-auth');
  vi.mocked(f.chain.outcome).mockRejectedValue(new Error('RPC timeout'));
  await f.payments.reconcile(a.id);
  const saved = await f.service.get(wallet.owner,wallet.id,run.id);
  expect(saved.status).toBe('in_progress'); expect(saved.confirmedCount).toBe(0); expect(saved.items[0].attempt?.status).toBe('unknown');
  expect((await f.service.prepareLine(wallet.owner,wallet.id,run.id,'employee-1')).id).toBe(a.id);
  expect(f.chain.prepare).toHaveBeenCalledTimes(1);
});
it('detects a mismatched attempt attached to a payroll line', async () => {
  const f = fixture(), run = await f.service.create(wallet.owner,wallet.id,input), stored = f.runs.get(run.id)!;
  await f.payments.create(wallet.owner,wallet.id,{...intent,amountStroops:'999'},lineKey(stored,'employee-1'));
  await expect(f.service.get(wallet.owner,wallet.id,run.id)).rejects.toThrow('PAY_RUN_ATTEMPT_MISMATCH');
});
it('requires authentication, trusted origins and bounded schema on HTTP routes', async () => {
  const f = fixture(), app = Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});
  await registerPayrollRoutes(app,{ service:f.payments,origin:'https://wallet.example',authenticate:async req => req.headers.authorization === 'Bearer valid' ? {subject:wallet.owner} : null },f.store);
  const url = `/api/v1/wallets/${wallet.id}/payroll`;
  try {
    expect((await app.inject({url})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url,payload:input,headers:{authorization:'Bearer valid'}})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url,payload:{...input,owner:'outsider'},headers:{origin:'https://wallet.example',authorization:'Bearer valid'}})).statusCode).toBe(400);
    const response = await app.inject({method:'POST',url,payload:input,headers:{origin:'https://wallet.example',authorization:'Bearer valid'}});
    expect(response.statusCode).toBe(200); expect(response.json().status).toBe('draft');
  } finally { await app.close(); }
});
