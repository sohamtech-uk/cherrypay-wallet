import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { vi } from 'vitest';
import { NETWORK, type Chain, type Intent, type PolicyReader, type TransferEvent, type Wallet } from './model.js';
export const wallet: Wallet = { id: 'wallet-1', owner: 'alice', address: StrKey.encodeContract(Buffer.alloc(32, 7)), policy: 'policy-v1', routes: ['classic', 'contract'], createdAt: 1 };
export const destination = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
export const intent: Intent = { network: NETWORK, destination, amountStroops: '10000001', maxFeeStroops: '1000000' };
export const txHash = 'a'.repeat(64);
export function transfer(overrides: Partial<TransferEvent> = {}): TransferEvent {
  return { id: `${NETWORK}:${txHash}:0:0`, transactionHash: txHash, ledger: 100, operationIndex: 0, eventIndex: 0, from: wallet.address, to: destination, amountStroops: intent.amountStroops, closedAt: 1, ...overrides };
}
export function mockChain(): Chain {
  return {
    prepare: vi.fn(async () => ({ transactionXdr: 'unsigned', authXdr: 'challenge', feeStroops: intent.maxFeeStroops, expiresAt: Date.now() + 60000, expirationLedger: 130, ledger: 100 })),
    authorize: vi.fn(async () => ({ signedXdr: 'signed-identical-bytes', transactionHash: txHash })),
    submit: vi.fn(async () => {}), outcome: vi.fn(async () => ({ status: 'NOT_FOUND' as const })),
    balance: vi.fn(async () => ({ amountStroops: '90000000', ledger: 100 })),
    events: vi.fn(async () => ({ events: [], cursor: 'cursor-1' })),
  };
}
export function mockPolicy(): PolicyReader { return { current: vi.fn(async () => ({ fingerprint: wallet.policy, recoveryReady: true })) }; }
