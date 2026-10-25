import { Keypair, rpc } from '@stellar/stellar-sdk';
import { TESTNET_RPC_URL } from '../config.js';
import { type PolicyReader } from './model.js';
import type { PaymentRepository } from './repository.js';
import { StellarChain } from './stellar.js';
import { PaymentService } from './service.js';

/** Call only from a trusted composition root after the B1/B2 deployment gate passes.
 * Never accept these settings or wallet provisioning from HTTP request data.
 */
export function createPaymentRuntime(options: { repository: PaymentRepository; relayerSecret: string; policyReader: PolicyReader; startLedger: number }) {
  const chain = new StellarChain(new rpc.Server(TESTNET_RPC_URL, { timeout: 20 }), Keypair.fromSecret(options.relayerSecret));
  return new PaymentService(options.repository, chain, options.policyReader, options.startLedger);
}
