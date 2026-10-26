import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from './test-support/memory-repository.js';
import { PaymentService } from './service.js';
import { PaymentError, type Intent } from './model.js';
import { intent, mockChain, mockPolicy, transfer, txHash, wallet } from './test-fixtures.js';
let store: MemoryRepository; let chain: ReturnType<typeof mockChain>; let policies: ReturnType<typeof mockPolicy>; let service: PaymentService;
const key = 'idempotency-key-0001';
beforeEach(() => { store = new MemoryRepository(); store.register(wallet); chain = mockChain(); policies = mockPolicy(); service = new PaymentService(store, chain, policies, 1); });
const create = () => service.create('alice', wallet.id, intent, key);
describe('payment execution with an asynchronous repository contract', () => {
  it('recovers the same repository record after service reconstruction', async () => {
    const a = await create(); service = new PaymentService(store, chain, policies, 1);
    expect((await create()).id).toBe(a.id); expect(chain.prepare).toHaveBeenCalledTimes(1);
  });
  it('rejects another owner and never broadcasts', async () => {
    await expect(service.create('bob', wallet.id, intent, key)).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' }); expect(chain.prepare).not.toHaveBeenCalled();
  });
  it('rejects unsupported destinations and overflowing amounts before RPC', async () => {
    for (const change of [{ destination: 'M'.repeat(69) }, { destination: 'C' + 'A'.repeat(55) }, { amountStroops: '1.5' }, { amountStroops: '9223372036854775808' }, { network: 'MAINNET' }]) {
      await expect(service.create('alice', wallet.id, { ...intent, ...change } as Intent, key)).rejects.toBeInstanceOf(PaymentError);
    }
    expect(chain.prepare).not.toHaveBeenCalled();
  });
  it('detects signer rotation before preparation and approval', async () => {
    vi.mocked(policies.current).mockResolvedValueOnce({ fingerprint: 'rotated', recoveryReady: true });
    await expect(create()).rejects.toMatchObject({ code: 'SIGNER_POLICY_CHANGED_OR_RECOVERY_UNREADY' });
    const a = await create(); vi.mocked(policies.current).mockResolvedValue({ fingerprint: 'rotated', recoveryReady: true });
    expect((await service.approve('alice', wallet.id, a.id, 'signed-auth')).status).toBe('rejected'); expect(chain.authorize).not.toHaveBeenCalled(); expect(chain.submit).not.toHaveBeenCalled();
  });
  it('rejects rotation during approval even if the signature check succeeded', async () => {
    const a = await create(); vi.mocked(policies.current).mockResolvedValueOnce({ fingerprint: wallet.policy, recoveryReady: true }).mockResolvedValueOnce({ fingerprint: 'rotated', recoveryReady: true });
    expect((await service.approve('alice', wallet.id, a.id, 'signed-auth')).status).toBe('rejected'); expect(chain.submit).not.toHaveBeenCalled();
  });
  it('records insufficient balance as a pre-submission rejection', async () => {
    vi.mocked(chain.prepare).mockRejectedValue(new PaymentError('INSUFFICIENT_BALANCE'));
    expect(await create()).toMatchObject({ status: 'rejected', failureCode: 'INSUFFICIENT_BALANCE' }); expect(chain.submit).not.toHaveBeenCalled();
  });
  it('resolves concurrent duplicate keys to one persistent record and blocks conflicting intents', async () => {
    const results = await Promise.all([create(), create()]); expect(results[0].id).toBe(results[1].id); expect(chain.prepare).toHaveBeenCalledTimes(1);
    await expect(service.create('alice', wallet.id, { ...intent, amountStroops: '2' }, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(service.create('alice', wallet.id, intent, key + 'new')).rejects.toMatchObject({ code: 'RELAYER_BUSY_RESOLVE_EXISTING_ATTEMPT' });
  });
  it('persists signed bytes before an RPC timeout and rebroadcasts only those bytes after service reconstruction', async () => {
    const a = await create(); vi.mocked(chain.submit).mockImplementationOnce(async bytes => {
      expect(await store.get(a.id)).toMatchObject({ signedXdr: bytes, transactionHash: txHash, status: 'unknown' }); throw new Error('timeout');
    });
    expect((await service.approve('alice', wallet.id, a.id, 'signed-auth')).status).toBe('unknown');
    service = new PaymentService(store, chain, policies, 1);
    await service.reconcile(a.id);
    expect(chain.submit).toHaveBeenNthCalledWith(1, 'signed-identical-bytes'); expect(chain.submit).toHaveBeenNthCalledWith(2, 'signed-identical-bytes'); expect(chain.authorize).toHaveBeenCalledTimes(1);
  });
  it('does not submit when lookup is unavailable or cancel a signed attempt', async () => {
    const a = await create(); vi.mocked(chain.outcome).mockRejectedValue(new Error('RPC outage'));
    const result = await service.approve('alice', wallet.id, a.id, 'signed-auth'); expect(result.status).toBe('unknown'); expect(chain.submit).not.toHaveBeenCalled();
    await expect(service.cancel('alice', wallet.id, a.id)).rejects.toThrow('CANNOT_CANCEL_SUBMITTED_ATTEMPT');
  });
  it('never confirms a success without the exact native transfer', async () => {
    const a = await create(); vi.mocked(chain.outcome).mockResolvedValue({ status: 'SUCCESS', transactionHash: txHash, events: [transfer({ amountStroops: '2' })] });
    expect(await service.approve('alice', wallet.id, a.id, 'signed-auth')).toMatchObject({ status: 'unknown', verified: false });
  });
  it('confirms exactly once and indexes the immutable event', async () => {
    const a = await create(); vi.mocked(chain.outcome).mockResolvedValue({ status: 'SUCCESS', transactionHash: txHash, events: [transfer()] });
    const confirmed = await service.approve('alice', wallet.id, a.id, 'signed-auth'); expect(confirmed).toMatchObject({ status: 'confirmed', verified: true, eventId: transfer().id });
    await service.reconcile(a.id); expect(await store.history(wallet.address)).toHaveLength(1); expect(chain.submit).not.toHaveBeenCalled();
  });
  it('only releases the submission slot for a verified terminal failure', async () => {
    const a = await create(); vi.mocked(chain.outcome).mockResolvedValue({ status: 'FAILED', transactionHash: txHash });
    expect((await service.approve('alice', wallet.id, a.id, 'signed-auth')).status).toBe('failed');
    expect((await service.create('alice', wallet.id, intent, key + 'next')).status).toBe('awaiting_approval');
  });
  it('keeps expired unknown outcomes locked, without rebroadcast or replacement', async () => {
    const a = await create(); await service.approve('alice', wallet.id, a.id, 'signed-auth');
    const persisted = await store.get(a.id); persisted.prepared!.expiresAt = Date.now() - 1; store.seedAttempt(persisted);
    vi.mocked(chain.submit).mockClear(); expect(await service.reconcile(a.id)).toMatchObject({ status: 'unknown', failureCode: 'EXPIRED_OUTCOME_UNRESOLVED' }); expect(chain.submit).not.toHaveBeenCalled();
    await expect(service.create('alice', wallet.id, intent, key + 'next')).rejects.toThrow('RELAYER_BUSY');
  });
  it('fences stale workers and protects signed bytes from replacement', async () => {
    const a = await create(); const claim = await store.claim(a.id, ['awaiting_approval']); const row = await store.get(a.id); row.leaseUntil = 0; store.seedAttempt(row);
    await store.claim(a.id, ['awaiting_approval']); await expect(store.finish(claim.attempt, claim.token)).rejects.toThrow('LEASE_LOST');
  });
  it('advances events and cursor atomically, deduplicates pages and retains the cursor on failure', async () => {
    vi.mocked(chain.events).mockResolvedValue({ events: [transfer()], cursor: 'cursor-1' }); await service.tick(); await service.tick();
    expect(await store.history(wallet.address)).toHaveLength(1); expect(await store.balance(wallet.address)).toMatchObject({ amountStroops: '90000000', ledger: 100 });
    vi.mocked(chain.events).mockRejectedValue(new Error('cursor outside retention')); await expect(service.tick()).rejects.toThrow(); expect(await store.cursor()).toBe('cursor-1');
    await expect(store.ingest([transfer({ amountStroops: '3' })], 'cursor-1', 'cursor-2')).rejects.toThrow('EVENT_ID_COLLISION'); expect(await store.cursor()).toBe('cursor-1');
  });
  it('prevents balance snapshots moving backwards', async () => { await store.setBalance(wallet.address, '10', 100); await store.setBalance(wallet.address, '1', 99); expect(await store.balance(wallet.address)).toMatchObject({ amountStroops: '10', ledger: 100 }); });
});

it('uses committed ready bytes after service reconstruction without signing again', async () => {
  const first = await create(); const claimed = await store.claim(first.id, ['awaiting_approval']); claimed.attempt.status = 'authorizing'; await store.checkpoint(claimed.attempt, claimed.token);
  claimed.attempt.status = 'ready'; claimed.attempt.signedXdr = 'persisted-before-crash'; claimed.attempt.transactionHash = txHash; await store.finish(claimed.attempt, claimed.token);
  service = new PaymentService(store, chain, policies, 1);
  await service.tick(); expect(chain.submit).toHaveBeenCalledWith('persisted-before-crash'); expect(chain.authorize).not.toHaveBeenCalled();
  const owned = await store.claim(first.id, ['pending']); owned.attempt.signedXdr = 'replacement'; await expect(store.checkpoint(owned.attempt, owned.token)).rejects.toThrow('SIGNED_TRANSACTION_IMMUTABLE');
});
it('leaves preparation retryable when RPC fails before any signing', async () => {
  vi.mocked(chain.prepare).mockRejectedValueOnce(new Error('timeout'));
  const first = await create(); expect(first.status).toBe('preparing'); await service.tick(); expect((await store.get(first.id)).status).toBe('awaiting_approval'); expect(chain.submit).not.toHaveBeenCalled();
});
it('does not release the slot for duplicate matching transfer events', async () => {
  const a = await create(); vi.mocked(chain.outcome).mockResolvedValue({ status: 'SUCCESS', transactionHash: txHash, events: [transfer(), transfer({ id: `TESTNET:${txHash}:0:1`, eventIndex: 1 })] });
  expect(await service.approve('alice', wallet.id, a.id, 'signed-auth')).toMatchObject({ status: 'unknown', verified: false });
});
it('rejects signer policy without independent recovery readiness', async () => {
  vi.mocked(policies.current).mockResolvedValue({ fingerprint: wallet.policy, recoveryReady: false });
  await expect(create()).rejects.toThrow('SIGNER_POLICY_CHANGED_OR_RECOVERY_UNREADY');
});
it('cancels only unsent attempts and rejects expired approval before authorization', async () => {
  const a = await create(); a.prepared!.expiresAt = Date.now() - 1; store.seedAttempt(a);
  expect(await service.approve('alice', wallet.id, a.id, 'signed-auth')).toMatchObject({ status: 'rejected', failureCode: 'QUOTE_EXPIRED' }); expect(chain.authorize).not.toHaveBeenCalled();
  const next = await service.create('alice', wallet.id, intent, key + 'next'); expect((await service.cancel('alice', wallet.id, next.id)).status).toBe('rejected');
});

it('waits for the asynchronous signed-byte commit before any broadcast', async () => {
  const first = await create();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const finish = store.finish.bind(store);
  vi.spyOn(store, 'finish').mockImplementation(async (a, token, events) => { if (a.status === 'ready') await gate; return finish(a, token, events); });
  const approval = service.approve('alice', wallet.id, first.id, 'signed-auth');
  await vi.waitFor(() => expect(chain.authorize).toHaveBeenCalledTimes(1));
  expect(chain.submit).not.toHaveBeenCalled();
  release(); await approval; expect(chain.submit).toHaveBeenCalledTimes(1);
});
it('does not broadcast if the repository cannot confirm the signed-byte commit', async () => {
  const first = await create();
  vi.spyOn(store, 'finish').mockRejectedValueOnce(new Error('MySQL commit acknowledgement lost'));
  await expect(service.approve('alice', wallet.id, first.id, 'signed-auth')).rejects.toThrow('commit acknowledgement lost');
  expect(chain.submit).not.toHaveBeenCalled();
});


describe('C-address-to-C-address Testnet payments', () => {
  it('accepts a separately provisioned recovered recipient and rejects stale recipient policy', async () => {
    const { StrKey } = await import('@stellar/stellar-sdk');
    const recipient = { ...wallet, id: 'receiver-wallet', owner: 'bob', address: StrKey.encodeContract(Buffer.alloc(32, 22)), routes: ['classic','contract'] as ('classic'|'contract')[] };
    store.register({ ...wallet, routes:['classic','contract'] }); store.register(recipient);
    const cIntent = { ...intent, destination: recipient.address };
    expect((await service.create('alice',wallet.id,cIntent,'cc-test-key-0000001')).status).toBe('awaiting_approval');
    expect(policies.current).toHaveBeenCalledWith(recipient.address);
  });
  it('rejects unprovisioned C recipients without preparing a transaction', async () => {
    const { StrKey } = await import('@stellar/stellar-sdk');
    store.register({ ...wallet, routes:['classic','contract'] });
    await expect(service.create('alice',wallet.id,{...intent,destination:StrKey.encodeContract(Buffer.alloc(32,23))},'cc-test-key-0000002')).rejects.toMatchObject({code:'UNVERIFIED_CONTRACT_RECIPIENT'});
    expect(chain.prepare).not.toHaveBeenCalled();
  });
  it('rejects a recipient whose recovery policy has changed', async () => {
    const { StrKey } = await import('@stellar/stellar-sdk');
    const recipient={...wallet,id:'receiver-wallet',owner:'bob',address:StrKey.encodeContract(Buffer.alloc(32,24)),routes:['classic','contract'] as ('classic'|'contract')[]};
    store.register({ ...wallet, routes:['classic','contract'] });store.register(recipient);
    vi.mocked(policies.current).mockResolvedValueOnce({fingerprint:'rotated-policy',recoveryReady:true});
    await expect(service.create('alice',wallet.id,{...intent,destination:recipient.address},'cc-test-key-0000003')).rejects.toMatchObject({code:'RECIPIENT_RECOVERY_OR_POLICY_UNREADY'});
    expect(chain.prepare).not.toHaveBeenCalled();
  });
});
