import { describe, expect, it, vi } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';
import { apiClient, ApiError, connectPaymentAdapter, discoverWallets, type ApiClient } from './api';
const address = StrKey.encodeContract(Buffer.alloc(32, 1));
const destination = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const intent = { network: 'TESTNET' as const, from: address, destination, amountStroops: '10000001' };
const wallet = { id: 'wallet-1', address, network: 'TESTNET', supportedDestinations: ['classic'] };
function attempt(overrides = {}) { return { id: 'attempt-1', walletId: wallet.id, ...intent, status: 'awaiting_approval', createdAt: new Date().toISOString(), verified: false, feeStroops: '123', feePayer: 'sponsor', approval: { authXdr: 'AAAA', expirationLedger: 100, expiresAt: new Date(Date.now() + 60000).toISOString() }, ...overrides }; }
function fixture() {
  const raw = attempt();
  const api = vi.fn<ApiClient>(async path => {
    if (path === 'wallets/wallet-1') return wallet;
    if (path.endsWith('/balance')) return { network: 'TESTNET', address, snapshot: { amountStroops: '100000000', ledger: 90, updatedAt: Date.now() } };
    return raw;
  });
  const signer = vi.fn(async () => 'BBBB');
  return { api, signer, raw };
}
describe('authenticated API adapter', () => {
  it('uses same-origin bearer requests and never automatically retries writes', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'PAYMENT_SERVICE_UNAVAILABLE' }), { status: 503 }));
    const api = apiClient(() => 'session', transport);
    await expect(api('wallets/w/attempts', { amountStroops: '1' }, { 'Idempotency-Key': 'existing-key' })).rejects.toBeInstanceOf(ApiError);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe('/api/v1/wallets/w/attempts');
    expect(transport.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', headers: { Authorization: 'Bearer session', 'Idempotency-Key': 'existing-key' } });
  });
  it('persists preview once, reuses that attempt and signs the exact reviewed authorization', async () => {
    const { api, signer, raw } = fixture(); const adapter = await connectPaymentAdapter(api, wallet.id, signer);
    const quote = await adapter.prepare(intent, 'saved-recovery-key');
    expect(quote.feeStroops).toBe('123'); expect(quote.amountStroops).toBe('10000001');
    expect(api).toHaveBeenCalledWith('wallets/wallet-1/attempts', { network: 'TESTNET', destination, amountStroops: '10000001', maxFeeStroops: '10000000' }, { 'Idempotency-Key': 'saved-recovery-key' });
    await adapter.createAttempt(quote, 'saved-recovery-key');
    await adapter.approve(raw.id, quote);
    expect(signer).toHaveBeenCalledWith({ attemptId: raw.id, walletId: wallet.id, intent, feeStroops: '123', ...raw.approval });
    expect(api.mock.calls.filter(([path,body]) => path.endsWith('/attempts') && body)).toHaveLength(1);
    expect(api).toHaveBeenCalledWith('wallets/wallet-1/attempts/attempt-1/approve', { authXdr: 'BBBB' });
  });
  it('requires signer and never infers receive support from outgoing routes', async () => {
    const { api } = fixture(); const adapter = await connectPaymentAdapter(api, wallet.id);
    expect(adapter.canSign).toBe(false); expect(adapter.receive).toBeUndefined();
    await expect(adapter.prepare(intent, 'saved-key')).rejects.toThrow('signing');
    expect(api).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign wallets, network changes and mutated payment previews', async () => {
    const { api, signer, raw } = fixture(); const adapter = await connectPaymentAdapter(api, wallet.id, signer);
    const quote = await adapter.prepare(intent, 'saved-key');
    raw.feeStroops = '124';
    await expect(adapter.approve(raw.id, quote)).rejects.toThrow('changed'); expect(signer).not.toHaveBeenCalled();
    raw.walletId = 'other'; await expect(adapter.getAttempt(raw.id)).rejects.toThrow('wallet');
    api.mockResolvedValue({ ...wallet, network: 'PUBLIC' }); await expect(connectPaymentAdapter(api, wallet.id)).rejects.toThrow('network');
  });
  it('retains unknown outcomes, maps backend intermediate states, and handles only exact not-found as absence', async () => {
    const { api, raw } = fixture(); const adapter = await connectPaymentAdapter(api, wallet.id);
    for (const status of ['preparing', 'authorizing', 'ready']) { raw.status = status; expect((await adapter.getAttempt(raw.id)).status).toBe('pending'); }
    raw.status = 'unknown'; expect((await adapter.getAttempt(raw.id)).status).toBe('unknown');
    api.mockRejectedValue(new ApiError(404, 'WALLET_NOT_FOUND')); await expect(adapter.getAttemptByKey('key')).rejects.toThrow();
    api.mockRejectedValue(new ApiError(404, 'ATTEMPT_NOT_FOUND')); expect(await adapter.getAttemptByKey('key')).toBeNull();
  });
  it('maps verified incoming events independently of attempts and ignores API receipt URLs', async () => {
    const { api } = fixture(); const adapter = await connectPaymentAdapter(api, wallet.id);
    const hash = 'a'.repeat(64); const event = { id: `TESTNET:${hash}:0:2`, transactionHash: hash, from: destination, to: address, amountStroops: '7', closedAt: Date.now(), operationIndex: 0, eventIndex: 2, verified: true, receipt: 'https://evil.example' };
    api.mockResolvedValue({ network: 'TESTNET', items: [event], nextCursor: 'next/+' });
    const page = await adapter.listTransfers!('cursor/+'); expect(page.items[0]).toMatchObject({ destination: address, amountStroops: '7', verified: true, feeKnown: false });
    expect(page.items[0]).not.toHaveProperty('receipt'); expect(api).toHaveBeenLastCalledWith('wallets/wallet-1/history?cursor=cursor%2F%2B');
    api.mockResolvedValue({ network: 'TESTNET', items: [{ ...event, verified: false }] }); await expect(adapter.listTransfers!()).rejects.toThrow('event');
  });
  it('does not post approval when the signer rejects or the quote expires', async () => {
    const { api, signer } = fixture(); const adapter = await connectPaymentAdapter(api, wallet.id, signer);
    const quote = await adapter.prepare(intent, 'saved-key'); signer.mockRejectedValue(Error('cancelled'));
    await expect(adapter.approve(quote.id, quote)).rejects.toThrow('cancelled');
    expect(api.mock.calls.some(([path]) => path.endsWith('/approve'))).toBe(false);
  });
});
it('uses begin/finish WebAuthn endpoints only when advertised by the backend',async()=>{
  const {api,raw}=fixture();
  api.mockImplementation(async (path)=>{
    if(path==='wallets/wallet-1') return {...wallet,approvalMode:'webauthn'};
    if(path.endsWith('/balance')) return {network:'TESTNET',address,snapshot:{amountStroops:'100000000',ledger:90,updatedAt:Date.now()}};
    if(path.endsWith('/approval/options')) return {requestID:'request-1',attempt:raw,expiresAt:raw.approval.expiresAt,options:{challenge:'a'.repeat(43),rpId:'wallet.example',userVerification:'required',allowCredentials:[{type:'public-key',id:'credential'}]}};
    if(path.endsWith('/approval/verify')) return {...raw,status:'pending'};
    return raw;
  });
  const assertion={id:'credential',rawId:'credential',type:'public-key' as const,response:{authenticatorData:'AA',clientDataJSON:'AA',signature:'AA'},clientExtensionResults:{}};
  const authenticate=vi.fn(async()=>assertion);
  const externalSigner=vi.fn(async()=> 'must-not-be-used');
  const adapter=await connectPaymentAdapter(api,wallet.id,externalSigner,authenticate);
  expect(adapter.canSign).toBe(true);
  const q=await adapter.prepare(intent,'saved-key');
  expect((await adapter.approve(q.id,q)).status).toBe('pending');
  expect(authenticate).toHaveBeenCalledTimes(1);
  expect(externalSigner).not.toHaveBeenCalled();
  expect(api).toHaveBeenCalledWith('wallets/wallet-1/attempts/attempt-1/approval/verify',{requestID:'request-1',response:assertion});
  expect(api.mock.calls.some(([path])=>path.endsWith('/approve'))).toBe(false);
});

it('validates discovery network, unique wallet identities and bounded response size',async()=>{
  const row={id:wallet.id,address,network:'TESTNET'},api=vi.fn<ApiClient>();
  api.mockResolvedValue({network:'TESTNET',items:[row]});expect(await discoverWallets(api)).toEqual([{id:wallet.id,address}]);
  for(const page of [{network:'PUBLIC',items:[row]},{network:'TESTNET',items:[row,row]},{network:'TESTNET',items:[{...row,id:'path/escape'}]},{network:'TESTNET',items:[{...row,address:destination}]},{network:'TESTNET',items:Array(101).fill(row)}]){api.mockResolvedValue(page);await expect(discoverWallets(api)).rejects.toThrow();}
});
it('refuses a mutated begin-approval response before opening the authenticator',async()=>{
  const {api,raw}=fixture();
  const original=api.getMockImplementation()!;
  api.mockImplementation(async(path,...args)=>path==='wallets/wallet-1'?{...wallet,approvalMode:'webauthn'}:path.endsWith('/approval/options')?{requestID:'request',attempt:{...raw,amountStroops:'2'},expiresAt:raw.approval.expiresAt}:original(path,...args));
  const authenticate=vi.fn();const adapter=await connectPaymentAdapter(api,wallet.id,undefined,authenticate);
  const q=await adapter.prepare(intent,'saved-key');await expect(adapter.approve(q.id,q)).rejects.toThrow('differs');expect(authenticate).not.toHaveBeenCalled();
});

it('validates payroll wallet, line binding, exact totals and confirmed status', async () => {
  const {api,signer} = fixture(); const adapter = await connectPaymentAdapter(api,wallet.id,signer);
  const run = {id:'run-1',walletId:wallet.id,network:'TESTNET',reference:'october',maxFeeStroops:'123',totalStroops:'10000001',confirmedCount:0,status:'draft',items:[{reference:'employee-1',destination,amountStroops:'10000001',attempt:null}]};
  api.mockResolvedValue(run);
  expect((await adapter.payroll!.get('run-1')).totalStroops).toBe('10000001');
  for (const changed of [{...run,walletId:'other'},{...run,totalStroops:'10000002'},{...run,status:'completed'},{...run,items:[{...run.items[0],attempt:attempt({maxFeeStroops:'123',destination:address})}]}]) {
    api.mockResolvedValue(changed); await expect(adapter.payroll!.get('run-1')).rejects.toThrow();
  }
  expect(signer).not.toHaveBeenCalled();
});

it('accepts reset only for the exact saved wallet key and a terminal or absent attempt',async()=>{
 const {api}=fixture(),adapter=await connectPaymentAdapter(api,wallet.id),key='confirmed-reset-key';
 const result={network:'TESTNET',walletId:wallet.id,key,reset:true,outcome:'not_created'};
 api.mockResolvedValue(result);await expect(adapter.resetAttempt!(key)).resolves.toBeUndefined();
 expect(api).toHaveBeenCalledWith('wallets/wallet-1/attempt-by-key/'+key+'/reset',{});
 for(const patch of [{key:'different-reset-key'},{walletId:'other'},{network:'PUBLIC'},{reset:false},{outcome:'cancelled',attempt:attempt({status:'unknown',transactionHash:'a'.repeat(64)})},{outcome:'confirmed',attempt:attempt({status:'confirmed',verified:false,transactionHash:'a'.repeat(64)})}]){
   api.mockResolvedValue({...result,...patch});await expect(adapter.resetAttempt!(key)).rejects.toThrow();
 }
 api.mockResolvedValue({...result,outcome:'cancelled',attempt:attempt({status:'rejected'})});await expect(adapter.resetAttempt!(key)).resolves.toBeUndefined();
});
it('does not treat reset network failure or HTTP not-found as permission to discard recovery',async()=>{
 const {api}=fixture(),adapter=await connectPaymentAdapter(api,wallet.id);
 for(const error of [new ApiError(404,'ATTEMPT_NOT_FOUND'),new ApiError(409,'CANNOT_CANCEL_SUBMITTED_ATTEMPT'),Error('timeout')]){
  api.mockRejectedValue(error);await expect(adapter.resetAttempt!('unresolved-reset-key')).rejects.toThrow('Reset could not be confirmed');
 }
});


it('distinguishes email delivery failures from unavailable payment services without retrying', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({error:'EMAIL_DELIVERY_UNAVAILABLE'}), {status:503}));
  await expect(apiClient(()=>'session', transport)('wallet/email-verification/request', {})).rejects.toThrow('We could not send your verification email');
  expect(transport).toHaveBeenCalledTimes(1);
});
