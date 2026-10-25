import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { ACCOUNT_V080_HASH, PinnedAccountAdapter, type ApprovedAccount } from './pinned-adapter.js';
import { createPinnedPaymentRuntime } from './runtime.js';
import type { PaymentRepository } from '../payments/repository.js';
import { wallet } from '../payments/test-fixtures.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const account: ApprovedAccount = {
    walletId: wallet.id, owner: wallet.owner, address: wallet.address,
    accountWasmHash: ACCOUNT_V080_HASH,
    verifierAddress: StrKey.encodeContract(Buffer.alloc(32, 8)), verifierWasmHash: 'a'.repeat(64),
    primaryRuleId: 1, backupRuleId: 2, primaryCredentialId: 'primary', backupCredentialId: 'backup',
    deploymentTransactionHash: 'b'.repeat(64), recoveryTransactionHash: 'c'.repeat(64),
  };
  const stored = { ...wallet, routes: ['classic'] as ('classic'|'contract')[] };
  const repository = { wallet: vi.fn(async () => stored) } as unknown as PaymentRepository;
  const policy = vi.spyOn(PinnedAccountAdapter.prototype, 'current').mockResolvedValue({fingerprint: wallet.policy, recoveryReady: true});
  return { stored, policy, options: { accounts: [account], repository, relayerSecret: Keypair.random().secret(), startLedger: 100 } };
}
it('composes the same on-chain policy codec into payments and approval after checking stored ownership', async () => {
  const f = fixture(), runtime = await createPinnedPaymentRuntime(f.options);
  expect(runtime.passkeyCodec).toBeInstanceOf(PinnedAccountAdapter);
  expect(runtime.payments).toBeDefined();
  expect(f.options.repository.wallet).toHaveBeenCalledWith(wallet.id, wallet.owner);
  expect(f.policy).toHaveBeenCalledWith(wallet.address);
});
it('refuses invalid indexing boundaries before contacting chain or storage', async () => {
  const f = fixture();
  for (const startLedger of [0, -1, 1.5, Number.NaN, 0x100000000]) {
    await expect(createPinnedPaymentRuntime({ ...f.options, startLedger })).rejects.toThrow('INVALID_MONITOR_START_LEDGER');
  }
  await expect(createPinnedPaymentRuntime({ ...f.options, accounts: [] })).rejects.toThrow('APPROVED_ACCOUNTS_REQUIRED');
  expect(f.options.repository.wallet).not.toHaveBeenCalled();
});
it('fails startup on signer changes, wrong saved address or unsupported destination policy', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.stored.policy = 'old-policy'; },
    (f: ReturnType<typeof fixture>) => { f.stored.address = f.options.accounts[0].verifierAddress; },
    (f: ReturnType<typeof fixture>) => { f.stored.routes = ['contract']; },
  ]) {
    const f = fixture(); mutate(f);
    await expect(createPinnedPaymentRuntime(f.options)).rejects.toThrow();
  }
});
