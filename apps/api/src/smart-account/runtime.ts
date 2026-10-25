import { Keypair, rpc } from '@stellar/stellar-sdk';
import { TESTNET_RPC_URL } from '../config.js';
import { requireThat } from '../payments/model.js';
import type { PaymentRepository } from '../payments/repository.js';
import { PostgresPaymentRepository } from '../payments/postgres-repository.js';
import { PaymentService } from '../payments/service.js';
import { StellarChain } from '../payments/stellar.js';
import { PinnedAccountAdapter, type ApprovedAccount } from './pinned-adapter.js';
import { verifiedReceiveRoutes } from './receive-route.js';
import { ContractRulePolicyReader, TestnetContractRuleReader, type CredentialSource, type RuleSelection } from './contract-rule-reader.js';
import { StellarPasskeyCodec } from './passkey-codec.js';
import { SMART_ACCOUNT_KIT } from './kit-manifest.js';

/** Trusted server composition only. The caller has accepted deployment and
 * independent recovery evidence; HTTP input must never populate this manifest.
 * Existing wallet rows must match exactly. This function neither provisions
 * accounts nor silently updates a saved policy after a signer change.
 */
export async function createPinnedPaymentRuntime(options: {
  accounts: readonly ApprovedAccount[];
  relayerSecret: string;
  startLedger: number;
  repository?: PaymentRepository;
}) {
  requireThat(Number.isSafeInteger(options.startLedger) && options.startLedger > 0 && options.startLedger <= 0xffffffff, 'INVALID_MONITOR_START_LEDGER');
  requireThat(Array.isArray(options.accounts) && options.accounts.length > 0, 'APPROVED_ACCOUNTS_REQUIRED');
  const repository = options.repository ?? new PostgresPaymentRepository();
  const server = new rpc.Server(TESTNET_RPC_URL, { timeout: 20 });
  const codec = new PinnedAccountAdapter(server, options.accounts);
  const chain = new StellarChain(server, Keypair.fromSecret(options.relayerSecret));
  for (const account of options.accounts) {
    const wallet = await repository.wallet(account.walletId, account.owner);
    const policy = await codec.current(account.address);
    requireThat(wallet.address === account.address && wallet.policy === policy.fingerprint && policy.recoveryReady, 'APPROVED_WALLET_BINDING_MISMATCH');
    requireThat(wallet.routes.length === 1 && wallet.routes[0] === 'classic', 'INITIAL_RELEASE_REQUIRES_C_TO_G');
  }
  return {
    payments: new PaymentService(repository, chain, codec, options.startLedger),
    passkeyCodec: codec,
    receiveRoute: verifiedReceiveRoutes(repository, codec, server, new Map(options.accounts.map(account => [account.address, account]))),
  };
}

export type RuleReaderAccount = Readonly<{ walletId: string; owner: string; address: string }>;
/** Trusted composition for the patched account WASM pinned in SMART_ACCOUNT_KIT.
 * Payments, approvals and receive routes share ONE TestnetContractRuleReader, so the
 * fingerprint saved at prepare time is the one StellarPasskeyCodec re-reads at approval.
 * Rule IDs and verifier come from reviewed deployment evidence, never HTTP input.
 * Not activated by startServer(): configuredPayments() composes the manifest-pinned runtime.
 */
export async function createRuleReaderPaymentRuntime(options: {
  accounts: readonly RuleReaderAccount[];
  selection: RuleSelection;
  relayerSecret: string;
  startLedger: number;
  repository?: PaymentRepository;
  server?: rpc.Server;
  credentials?: CredentialSource;
}) {
  requireThat(Number.isSafeInteger(options.startLedger) && options.startLedger > 0 && options.startLedger <= 0xffffffff, 'INVALID_MONITOR_START_LEDGER');
  requireThat(Array.isArray(options.accounts) && options.accounts.length > 0, 'APPROVED_ACCOUNTS_REQUIRED');
  requireThat(new Set(options.accounts.map(a => a.address)).size === options.accounts.length, 'DUPLICATE_APPROVED_ACCOUNT');
  requireThat(options.selection.verifier === SMART_ACCOUNT_KIT.webauthnVerifierAddress, 'VERIFIER_NOT_ALLOWLISTED');
  const repository = options.repository ?? new PostgresPaymentRepository();
  const server = options.server ?? new rpc.Server(TESTNET_RPC_URL, { timeout: 20 });
  const reader = new TestnetContractRuleReader(options.selection, server);
  const policyReader = new ContractRulePolicyReader(reader, new Map(options.accounts.map(a => [a.address, a.owner])), options.credentials);
  for (const account of options.accounts) {
    const wallet = await repository.wallet(account.walletId, account.owner);
    const policy = await policyReader.current(account.address);
    requireThat(wallet.address === account.address && wallet.policy === policy.fingerprint && policy.recoveryReady, 'APPROVED_WALLET_BINDING_MISMATCH');
    requireThat(wallet.routes.length === 1 && wallet.routes[0] === 'classic', 'INITIAL_RELEASE_REQUIRES_C_TO_G');
  }
  const deployment = { accountWasmHash: SMART_ACCOUNT_KIT.accountWasmHash, verifierAddress: SMART_ACCOUNT_KIT.webauthnVerifierAddress, verifierWasmHash: SMART_ACCOUNT_KIT.webauthnVerifierWasmHash };
  return {
    payments: new PaymentService(repository, new StellarChain(server, Keypair.fromSecret(options.relayerSecret)), policyReader, options.startLedger),
    passkeyCodec: new StellarPasskeyCodec(reader),
    policyReader,
    receiveRoute: verifiedReceiveRoutes(repository, policyReader, server, new Map(options.accounts.map(account => [account.address, deployment]))),
  };
}
