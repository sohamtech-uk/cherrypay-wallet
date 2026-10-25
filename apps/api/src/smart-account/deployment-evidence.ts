import { rejectLegacyAccountWasm } from './kit-manifest.js';
import { createHash } from 'node:crypto';
import { Address, FeeBumpTransaction, StrKey, TransactionBuilder, hash, rpc, xdr } from '@stellar/stellar-sdk';
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

/** Derive the address from the creation preimage, including the network ID. */
export function deploymentAddress(preimage: xdr.ContractIdPreimage): string {
  const id = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({
    networkId: hash(Buffer.from(TESTNET_PASSPHRASE)), contractIdPreimage: preimage,
  }));
  return StrKey.encodeContract(hash(id.toXDR()));
}

/** Prove that the committed envelope actually created this address and WASM.
 * Current code/TTL and signer rules are separate checks; sourceCommit is an
 * operator provenance reference, not something a transaction can prove.
 */
export function inspectDeploymentTransaction(evidence: DeploymentEvidence, response: rpc.Api.GetTransactionResponse) {
  validateDeploymentEvidence(evidence);
  rejectLegacyAccountWasm(evidence.wasmSha256);
  if (response.status !== 'SUCCESS' || response.txHash !== evidence.deploymentTransactionHash ||
      !Number.isSafeInteger(response.ledger) || response.ledger <= 0) throw Error('DEPLOYMENT_NOT_CONFIRMED');
  const envelope = TransactionBuilder.fromXDR(response.envelopeXdr, TESTNET_PASSPHRASE);
  if (envelope.hash().toString('hex') !== evidence.deploymentTransactionHash) throw Error('DEPLOYMENT_ENVELOPE_MISMATCH');
  const result = response.resultXdr.result().switch().name;
  if (result !== (envelope instanceof FeeBumpTransaction ? 'txFeeBumpInnerSuccess' : 'txSuccess')) throw Error('DEPLOYMENT_RESULT_MISMATCH');
  const tx = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
  const creates = tx.operations.filter(op => op.type === 'invokeHostFunction' &&
    op.func.switch().name === 'hostFunctionTypeCreateContractV2' &&
    deploymentAddress(op.func.createContractV2().contractIdPreimage()) === evidence.contractAddress);
  if (creates.length !== 1 || creates[0].type !== 'invokeHostFunction') throw Error('DEPLOYMENT_ADDRESS_NOT_CREATED');
  const create = creates[0].func.createContractV2(), executable = create.executable();
  if (executable.switch().name !== 'contractExecutableWasm' ||
      Buffer.from(executable.wasmHash()).toString('hex') !== evidence.wasmSha256) throw Error('DEPLOYMENT_WASM_MISMATCH');
  return { contractAddress: evidence.contractAddress, transactionHash: response.txHash, ledger: response.ledger };
}

export async function verifyTestnetDeployment(evidence: DeploymentEvidence, server: Pick<rpc.Server, 'getNetwork' | 'getTransaction'>) {
  validateDeploymentEvidence(evidence);
  if ((await server.getNetwork()).passphrase !== TESTNET_PASSPHRASE) throw Error('RPC_NETWORK_MISMATCH');
  return inspectDeploymentTransaction(evidence, await server.getTransaction(evidence.deploymentTransactionHash));
}

export function createTestnetRpc(): rpc.Server {
  return new rpc.Server(TESTNET_RPC_URL, { timeout: 20 });
}

