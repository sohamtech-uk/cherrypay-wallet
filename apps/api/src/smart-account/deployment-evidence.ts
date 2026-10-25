import { requireApprovedAccountWasm } from './kit-manifest.js';
import { createHash } from 'node:crypto';
import { Address, StrKey, rpc } from '@stellar/stellar-sdk';
import { TESTNET_PASSPHRASE, TESTNET_RPC_URL } from '../config.js';

/**
 * Phase 1 / Gate C: verify independently deployed Testnet smart-account evidence.
 * This module never deploys a contract or handles signing keys.
 * A deployment is not trusted merely because an address was supplied.
 */
export type DeploymentEvidence = Readonly<{
  contractAddress: string;
  wasmSha256: string;
  deploymentTransactionHash: string;
  sourceCommit: string;
}>;

const sha256 = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;

export function validateDeploymentEvidence(evidence: DeploymentEvidence): void {
  if (!StrKey.isValidContract(evidence.contractAddress) ||
      !sha256.test(evidence.wasmSha256) ||
      !sha256.test(evidence.deploymentTransactionHash) ||
      !commit.test(evidence.sourceCommit)) {
    throw new Error('INVALID_DEPLOYMENT_EVIDENCE');
  }
  if (Address.fromString(evidence.contractAddress).toString() !== evidence.contractAddress) {
    throw new Error('NONCANONICAL_CONTRACT_ADDRESS');
  }
}

export function hashWasm(wasm: Uint8Array): string {
  if (wasm.byteLength === 0) throw new Error('EMPTY_CONTRACT_WASM');
  return createHash('sha256').update(wasm).digest('hex');
}

/** Reject wrong networks and unconfirmed/failed deployment transactions. */
export async function verifyTestnetDeployment(
  evidence: DeploymentEvidence,
  server: Pick<rpc.Server, 'getNetwork' | 'getTransaction'>,
): Promise<{ contractAddress: string; transactionHash: string; ledger: number }> {
  validateDeploymentEvidence(evidence);
  requireApprovedAccountWasm(evidence.wasmSha256);
  const network = await server.getNetwork();
  if (network.passphrase !== TESTNET_PASSPHRASE) throw new Error('RPC_NETWORK_MISMATCH');
  const transaction = await server.getTransaction(evidence.deploymentTransactionHash);
  if (transaction.status !== 'SUCCESS' ||
      transaction.txHash !== evidence.deploymentTransactionHash ||
      !Number.isSafeInteger(transaction.ledger) || transaction.ledger <= 0) {
    throw new Error('DEPLOYMENT_NOT_CONFIRMED');
  }
  // A successful transaction alone does NOT prove that the specified contract
  // was deployed by it or that its executable WASM matches the supplied hash.
  // The caller must independently verify contract-instance and code ledger entries.
  return { contractAddress: evidence.contractAddress, transactionHash: transaction.txHash, ledger: transaction.ledger };
}

export function createTestnetRpc(): rpc.Server {
  return new rpc.Server(TESTNET_RPC_URL, { timeout: 20 });
}

