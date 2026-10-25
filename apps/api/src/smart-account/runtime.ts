import { Keypair, rpc } from '@stellar/stellar-sdk';
import { TESTNET_RPC_URL } from '../config.js';
import { requireThat } from '../payments/model.js';
import type { PaymentRepository } from '../payments/repository.js';
import { PostgresPaymentRepository } from '../payments/postgres-repository.js';
import { PaymentService } from '../payments/service.js';
import { StellarChain } from '../payments/stellar.js';
import { PinnedAccountAdapter, type ApprovedAccount } from './pinned-adapter.js';
import { verifiedReceiveRoutes } from './receive-route.js';

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
    requireThat(JSON.stringify(wallet.routes) === JSON.stringify(['classic','contract']), 'C_TO_C_ROUTE_POLICY_NOT_ENABLED');
  }
  return {
    payments: new PaymentService(repository, chain, codec, options.startLedger),
    passkeyCodec: codec,
    receiveRoute: verifiedReceiveRoutes(repository, codec, server, new Map(options.accounts.map(account => [account.address, account]))),
  };
}
