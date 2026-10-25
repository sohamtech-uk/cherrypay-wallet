import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_V080_HASH, PinnedAccountAdapter, type ApprovedAccount } from './pinned-adapter.js';
import { createPinnedPaymentRuntime, createRuleReaderPaymentRuntime, ruleReaderRuntimeFromEnv, ruleReaderSettingsFromEnv } from './runtime.js';
import { ContractRulePolicyReader } from './contract-rule-reader.js';
import { StellarPasskeyCodec } from './passkey-codec.js';
import { SMART_ACCOUNT_KIT } from './kit-manifest.js';
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

describe('createRuleReaderPaymentRuntime', () => {
  const selection = { transferRuleIds: [0], recoveryRuleId: 1, verifier: SMART_ACCOUNT_KIT.webauthnVerifierAddress };
  function ruleFixture(recoveryReady = true) {
    const stored = { ...wallet, routes: ['classic'] as ('classic'|'contract')[] };
    const repository = { wallet: vi.fn(async () => stored) } as unknown as PaymentRepository;
    const policy = vi.spyOn(ContractRulePolicyReader.prototype, 'current').mockResolvedValue({ fingerprint: wallet.policy, recoveryReady });
    return { stored, policy, options: { accounts: [{ walletId: wallet.id, owner: wallet.owner, address: wallet.address }], selection, repository, relayerSecret: Keypair.random().secret(), startLedger: 100 } };
  }
  it('composes one rule reader into payments, approval codec and policy reader', async () => {
    const f = ruleFixture(), runtime = await createRuleReaderPaymentRuntime(f.options);
    expect(runtime.passkeyCodec).toBeInstanceOf(StellarPasskeyCodec);
    expect(runtime.policyReader).toBeInstanceOf(ContractRulePolicyReader);
    expect(runtime.payments.policies).toBe(runtime.policyReader);
    expect(f.policy).toHaveBeenCalledWith(wallet.address);
  });
  it('fails startup without recovery, on policy drift or a non-allowlisted verifier', async () => {
    await expect(createRuleReaderPaymentRuntime(ruleFixture(false).options)).rejects.toThrow('APPROVED_WALLET_BINDING_MISMATCH');
    const drift = ruleFixture(); drift.stored.policy = 'old-policy';
    await expect(createRuleReaderPaymentRuntime(drift.options)).rejects.toThrow('APPROVED_WALLET_BINDING_MISMATCH');
    const f = ruleFixture();
    await expect(createRuleReaderPaymentRuntime({ ...f.options, selection: { ...selection, verifier: StrKey.encodeContract(Buffer.alloc(32, 7)) } })).rejects.toThrow('VERIFIER_NOT_ALLOWLISTED');
    expect(f.options.repository.wallet).not.toHaveBeenCalled();
  });
});

describe('ruleReaderSettingsFromEnv', () => {
  const base = { PAYMENT_RELAYER_SECRET: 'S-secret', PAYMENT_START_LEDGER: '1200', SMART_ACCOUNT_TRANSFER_RULE_IDS: '0', SMART_ACCOUNT_RECOVERY_RULE_ID: '1' };
  it('keeps payments disabled without a relayer secret', () => {
    expect(ruleReaderSettingsFromEnv({})).toBeUndefined();
  });
  it('parses rule selection and pins the verifier to the manifest', () => {
    expect(ruleReaderSettingsFromEnv({ ...base, SMART_ACCOUNT_TRANSFER_RULE_IDS: '0,2' })).toMatchObject({ startLedger: 1200, selection: { transferRuleIds: [0, 2], recoveryRuleId: 1, verifier: SMART_ACCOUNT_KIT.webauthnVerifierAddress } });
  });
  it('rejects malformed configuration instead of guessing', () => {
    expect(() => ruleReaderSettingsFromEnv({ ...base, PAYMENT_START_LEDGER: '' })).toThrow('INVALID_PAYMENT_START_LEDGER');
    expect(() => ruleReaderSettingsFromEnv({ ...base, SMART_ACCOUNT_TRANSFER_RULE_IDS: '' })).toThrow('SMART_ACCOUNT_TRANSFER_RULE_IDS_REQUIRED');
    expect(() => ruleReaderSettingsFromEnv({ ...base, SMART_ACCOUNT_TRANSFER_RULE_IDS: '0,x' })).toThrow('INVALID_TRANSFER_RULE_ID');
    expect(() => ruleReaderSettingsFromEnv({ ...base, SMART_ACCOUNT_RECOVERY_RULE_ID: '-1' })).toThrow('INVALID_RECOVERY_RULE_ID');
  });
  it('refuses to start payments with no registered wallets', async () => {
    const repository = { allWallets: vi.fn(async () => []) } as unknown as PaymentRepository;
    await expect(ruleReaderRuntimeFromEnv(base, repository)).rejects.toThrow('NO_REGISTERED_TESTNET_WALLETS');
    expect(await ruleReaderRuntimeFromEnv({}, repository)).toBeUndefined();
  });
});
