import { StrKey, xdr, type rpc } from '@stellar/stellar-sdk';
import { SMART_ACCOUNT_KIT, requireApprovedAccountWasm } from './kit-manifest.js';
import { TESTNET_PASSPHRASE } from '../config.js';

/** Read the executable from the actual contract instance, not from a claimed tx hash. */
export async function attestAccountCode(
  address: string,
  server: Pick<rpc.Server, 'getNetwork' | 'getContractData'>,
): Promise<{ address: string; wasmSha256: string; network: 'TESTNET'; verified: true }> {
  if (!StrKey.isValidContract(address)) throw new Error('INVALID_CONTRACT_ADDRESS');
  const network = await server.getNetwork();
  if (network.passphrase !== TESTNET_PASSPHRASE) throw new Error('RPC_NETWORK_MISMATCH');
  const instance = await server.getContractData(address, xdr.ScVal.scvLedgerKeyContractInstance());
  const executable = instance.val.contractData().val().instance().executable();
  if (executable.switch().name !== 'contractExecutableWasm') throw new Error('NOT_A_WASM_SMART_ACCOUNT');
  const wasmSha256 = Buffer.from(executable.wasmHash()).toString('hex');
  requireApprovedAccountWasm(wasmSha256);
  if (wasmSha256 !== SMART_ACCOUNT_KIT.accountWasmHash) throw new Error('ACCOUNT_CODE_MISMATCH');
  return { address, wasmSha256, network: 'TESTNET', verified: true };
}
