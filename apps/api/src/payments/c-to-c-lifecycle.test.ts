import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Address, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { PaymentService } from './service.js';
import { MemoryRepository } from './test-support/memory-repository.js';
import { intent, mockChain, mockPolicy, transfer, txHash, wallet } from './test-fixtures.js';
import { NATIVE_SAC, type Wallet } from './model.js';
import { decodeTransfer, transferOperation } from './stellar.js';

const receiver: Wallet = { ...wallet, id: 'receiver', owner: 'bob', address: StrKey.encodeContract(Buffer.alloc(32, 21)), policy: 'bob-policy', routes: ['classic', 'contract'] };
const payment = { ...intent, destination: receiver.address };
const key = 'c-to-c-lifecycle-key';
let store: MemoryRepository;
let chain: ReturnType<typeof mockChain>;
let policies: ReturnType<typeof mockPolicy>;
let service: PaymentService;
let receiverReady: boolean;
beforeEach(() => {
  receiverReady = true;
  store = new MemoryRepository(); store.register(wallet); store.register(receiver);
  chain = mockChain(); policies = mockPolicy();
  vi.mocked(policies.current).mockImplementation(async address => address === receiver.address
    ? { fingerprint: receiverReady ? receiver.policy : 'rotated', recoveryReady: receiverReady }
    : { fingerprint: wallet.policy, recoveryReady: true });
  service = new PaymentService(store, chain, policies, 1);
});
const create = () => service.create(wallet.owner, wallet.id, payment, key);

describe('two separately owned contract wallets', () => {
  it('encodes and decodes an exact native XLM SAC C-to-C transfer', () => {
    const call = transferOperation(wallet.address, receiver.address, payment.amountStroops).body().invokeHostFunctionOp().hostFunction().invokeContract();
    expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(NATIVE_SAC);
    expect(Address.fromScVal(call.args()[0]).toString()).toBe(wallet.address);
    expect(Address.fromScVal(call.args()[1]).toString()).toBe(receiver.address);
    const event = new xdr.ContractEvent({ ext: new xdr.ExtensionPoint(0), contractId: StrKey.decodeContract(NATIVE_SAC) as unknown as xdr.Hash, type: xdr.ContractEventType.contract(), body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics: [xdr.ScVal.scvSymbol('transfer'), new Address(wallet.address).toScVal(), new Address(receiver.address).toScVal()], data: nativeToScVal(BigInt(payment.amountStroops), { type: 'i128' }) })) });
    expect(decodeTransfer(event, txHash, 100, 0, 0, 1)).toMatchObject({ from: wallet.address, to: receiver.address, amountStroops: payment.amountStroops });
  });
  it('recovers the same attempt without new policy RPC calls when the recipient is unavailable', async () => {
    const original = await create();
    vi.mocked(policies.current).mockRejectedValue(new Error('RPC outage'));
    vi.mocked(policies.current).mockClear();
    expect((await create()).id).toBe(original.id);
    expect(policies.current).not.toHaveBeenCalled();
    expect(chain.prepare).toHaveBeenCalledTimes(1);
    await expect(service.get(receiver.owner, wallet.id, original.id)).rejects.toThrow('WALLET_NOT_FOUND');
  });
  it('rejects recipient rotation before asking the chain to authorize', async () => {
    const original = await create(); receiverReady = false;
    expect(await service.approve(wallet.owner, wallet.id, original.id, 'signed-auth')).toMatchObject({ status: 'rejected', failureCode: 'RECIPIENT_RECOVERY_OR_POLICY_UNREADY' });
    expect(chain.authorize).not.toHaveBeenCalled(); expect(chain.submit).not.toHaveBeenCalled();
  });
  it('rechecks the recipient after an asynchronous signature simulation', async () => {
    const original = await create();
    vi.mocked(chain.authorize).mockImplementationOnce(async () => { receiverReady = false; return { signedXdr: 'must-not-broadcast', transactionHash: txHash }; });
    expect(await service.approve(wallet.owner, wallet.id, original.id, 'signed-auth')).toMatchObject({ status: 'rejected', failureCode: 'RECIPIENT_RECOVERY_OR_POLICY_UNREADY' });
    expect((await store.get(original.id)).signedXdr).toBeUndefined(); expect(chain.submit).not.toHaveBeenCalled();
  });
  it('revalidates the recipient on preparation retry after an RPC outage', async () => {
    vi.mocked(chain.prepare).mockRejectedValueOnce(new Error('RPC unavailable'));
    const original = await create(); expect(original.status).toBe('preparing'); receiverReady = false;
    await service.tick();
    expect(await store.get(original.id)).toMatchObject({ status: 'rejected', failureCode: 'RECIPIENT_RECOVERY_OR_POLICY_UNREADY' });
    expect(chain.prepare).toHaveBeenCalledTimes(1); expect(chain.submit).not.toHaveBeenCalled();
  });
  it('retains signed unknown outcomes and stops rebroadcast if recipient authority changes', async () => {
    const original = await create();
    vi.mocked(chain.submit).mockRejectedValueOnce(new Error('timeout after send'));
    expect((await service.approve(wallet.owner, wallet.id, original.id, 'signed-auth')).status).toBe('unknown');
    receiverReady = false; vi.mocked(chain.submit).mockClear();
    const result = await service.reconcile(original.id);
    expect(result).toMatchObject({ status: 'unknown', signedXdr: 'signed-identical-bytes', transactionHash: txHash, failureCode: 'RECIPIENT_RECOVERY_OR_POLICY_UNREADY' });
    expect(chain.submit).not.toHaveBeenCalled();
    await expect(store.create(wallet, payment, key + '-new')).rejects.toThrow('RELAYER_BUSY');
  });
  it('recognizes an already confirmed transfer even if the recipient later rotates its signer', async () => {
    const original = await create();
    await service.approve(wallet.owner, wallet.id, original.id, 'signed-auth');
    receiverReady = false;
    vi.mocked(chain.outcome).mockResolvedValue({ status: 'SUCCESS', transactionHash: txHash, events: [transfer({ to: receiver.address })] });
    vi.mocked(policies.current).mockClear();
    expect(await service.reconcile(original.id)).toMatchObject({ status: 'confirmed', verified: true });
    expect(policies.current).not.toHaveBeenCalled();
    expect((await store.history(wallet.address))[0].event.to).toBe(receiver.address);
    expect((await store.history(receiver.address))[0].event.from).toBe(wallet.address);
  });
  it('indexes one transfer for both users, refreshes both balances and deduplicates replayed events', async () => {
    const original = await create(); const event = transfer({ to: receiver.address });
    vi.mocked(chain.outcome).mockResolvedValue({ status: 'SUCCESS', transactionHash: txHash, events: [event] });
    expect((await service.approve(wallet.owner, wallet.id, original.id, 'signed-auth')).verified).toBe(true);
    vi.mocked(chain.events).mockResolvedValue({ events: [event], cursor: 'c-to-c-page-1' });
    vi.mocked(chain.balance).mockImplementation(async address => ({ amountStroops: address === receiver.address ? payment.amountStroops : '79999999', ledger: 101 }));
    await service.tick(); await service.tick();
    expect(await store.history(wallet.address)).toHaveLength(1); expect(await store.history(receiver.address)).toHaveLength(1);
    expect(await store.balance(wallet.address)).toMatchObject({ amountStroops: '79999999', ledger: 101 });
    expect(await store.balance(receiver.address)).toMatchObject({ amountStroops: '10000001', ledger: 101 });
  });
  it('does not issue a confirmed receipt for the wrong receiver', async () => {
    const original = await create();
    vi.mocked(chain.outcome).mockResolvedValue({ status: 'SUCCESS', transactionHash: txHash, events: [transfer()] });
    expect(await service.approve(wallet.owner, wallet.id, original.id, 'signed-auth')).toMatchObject({ status: 'unknown', verified: false });
    expect(await store.history(receiver.address)).toHaveLength(0);
  });
});
