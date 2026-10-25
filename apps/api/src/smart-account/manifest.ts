import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { requireThat } from '../payments/model.js';
import { ACCOUNT_V080_HASH, type ApprovedAccount } from './pinned-adapter.js';
import { createPinnedPaymentRuntime } from './runtime.js';
import { validateKitV080DeploymentConfig, TESTNET_V080 } from './kit-v080-preflight.js';

export type PaymentManifest = Readonly<{
  version: 1; network: 'TESTNET'; startLedger: number;
  relayerPublicKey: string; accounts: readonly ApprovedAccount[];
}>;
const record = (value: unknown): Record<string, unknown> => {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_PAYMENT_MANIFEST');
  return value as Record<string, unknown>;
};
function fields(value: Record<string, unknown>, names: string[]) {
  requireThat(Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)), 'INVALID_MANIFEST_FIELDS');
}
const string = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const uint = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff;
const hash = /^[a-f0-9]{64}$/;
const credential = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 1279 && Buffer.from(value, 'base64url').toString('base64url') === value;

/** Strict local operator input, never request data. Evidence references attest to
 * prior human review; parsing them does not establish deployment or recovery. */
export function parsePaymentManifest(value: unknown): PaymentManifest {
  const m = record(value);
  fields(m, ['version', 'network', 'startLedger', 'relayerPublicKey', 'accounts']);
  requireThat(m.version === 1 && m.network === 'TESTNET', 'TESTNET_MANIFEST_REQUIRED');
  requireThat(uint(m.startLedger) && m.startLedger > 0, 'INVALID_MONITOR_START_LEDGER');
  requireThat(typeof m.relayerPublicKey === 'string' && StrKey.isValidEd25519PublicKey(m.relayerPublicKey), 'INVALID_RELAYER_PUBLIC_KEY');
  requireThat(Array.isArray(m.accounts) && m.accounts.length > 0 && m.accounts.length <= 100, 'INVALID_MANIFEST_ACCOUNTS');
  const accounts = m.accounts.map(value => {
    const a = record(value);
    fields(a, ['walletId','owner','address','accountWasmHash','verifierAddress','verifierWasmHash','primaryRuleId','backupRuleId','primaryCredentialId','backupCredentialId','deploymentTransactionHash','recoveryTransactionHash']);
    requireThat(string(a.walletId, /^[A-Za-z0-9_-]{1,128}$/) && typeof a.owner === 'string' && a.owner.length <= 254 && /^[^\s@A-Z]{1,64}@[^\s@A-Z]+\.[^\s@A-Z]+$/.test(a.owner), 'INVALID_MANIFEST_OWNER');
    requireThat(typeof a.address === 'string' && StrKey.isValidContract(a.address) && typeof a.verifierAddress === 'string' && StrKey.isValidContract(a.verifierAddress), 'INVALID_MANIFEST_ADDRESS');
    requireThat(a.accountWasmHash === ACCOUNT_V080_HASH && string(a.verifierWasmHash, hash), 'UNAPPROVED_MANIFEST_CODE');
    validateKitV080DeploymentConfig({networkPassphrase: TESTNET_V080.networkPassphrase, accountWasmHash: a.accountWasmHash as string, verifierAddress: a.verifierAddress as string, verifierWasmHash: a.verifierWasmHash as string});
    requireThat(uint(a.primaryRuleId) && uint(a.backupRuleId) && a.primaryRuleId !== a.backupRuleId, 'INVALID_MANIFEST_RULES');
    requireThat(credential(a.primaryCredentialId) && credential(a.backupCredentialId) && a.primaryCredentialId !== a.backupCredentialId, 'INVALID_MANIFEST_CREDENTIALS');
    requireThat(string(a.deploymentTransactionHash, hash) && string(a.recoveryTransactionHash, hash) && a.deploymentTransactionHash !== a.recoveryTransactionHash, 'MANIFEST_EVIDENCE_REQUIRED');
    return Object.freeze({ ...a }) as ApprovedAccount;
  });
  requireThat(new Set(accounts.map(a => a.address)).size === accounts.length && new Set(accounts.map(a => a.walletId)).size === accounts.length, 'DUPLICATE_MANIFEST_ACCOUNT');
  return Object.freeze({ version: 1, network: 'TESTNET', startLedger: m.startLedger, relayerPublicKey: m.relayerPublicKey, accounts: Object.freeze(accounts) });
}
export async function readPaymentManifest(path: string): Promise<PaymentManifest> {
  const limit = 1024 * 1024;
  // A mistaken FIFO path must not hang before the regular-file check.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    requireThat((await file.stat()).isFile(), 'MANIFEST_FILE_REQUIRED');
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used <= limit) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    requireThat(used <= limit, 'MANIFEST_TOO_LARGE');
    let value: unknown;
    try { value = JSON.parse(buffer.subarray(0, used).toString('utf8')); }
    catch { throw Error('INVALID_MANIFEST_JSON'); }
    return parsePaymentManifest(value);
  } finally { await file.close(); }
}
export async function configuredPayments(env: NodeJS.ProcessEnv = process.env) {
  requireThat(env.WALLET_PAYMENTS_ENABLED === undefined || ['false','true'].includes(env.WALLET_PAYMENTS_ENABLED), 'INVALID_PAYMENT_ENABLE_FLAG');
  if (env.WALLET_PAYMENTS_ENABLED !== 'true') return {};
  requireThat(env.WALLET_PAYMENT_MANIFEST && env.STELLAR_RELAYER_SECRET, 'PAYMENT_CONFIGURATION_REQUIRED');
  const manifest = await readPaymentManifest(env.WALLET_PAYMENT_MANIFEST);
  let relayer: Keypair;
  try { relayer = Keypair.fromSecret(env.STELLAR_RELAYER_SECRET); }
  catch { throw Error('INVALID_RELAYER_SECRET'); }
  requireThat(relayer.publicKey() === manifest.relayerPublicKey, 'RELAYER_IDENTITY_MISMATCH');
  return createPinnedPaymentRuntime({ accounts: manifest.accounts, startLedger: manifest.startLedger, relayerSecret: env.STELLAR_RELAYER_SECRET });
}
