import { Address, xdr, type rpc } from '@stellar/stellar-sdk';
import { TESTNET_PASSPHRASE } from '../config.js';
import { hashWasm } from './deployment-evidence.js';
import { rejectLegacyAccountWasm } from './kit-manifest.js';
import { requireThat, spendingReady, type PolicyReader } from '../payments/model.js';
import type { PaymentRepository } from '../payments/repository.js';

/** Verify BOTH instance and executable code using ledger keys, not an address claim.
 * approvedHash is supplied by trusted reviewed deployment configuration, never HTTP.
 * This checks current code; it does not prove a deployment transaction or recovery drill.
 */
export async function verifyCurrentContractCode(server: Pick<rpc.Server,'getNetwork'|'getLedgerEntries'>, address: string, approvedHash: string) {
  rejectLegacyAccountWasm(approvedHash);
  requireThat(/^[a-f0-9]{64}$/.test(approvedHash),'INVALID_APPROVED_WASM');
  requireThat((await server.getNetwork()).passphrase===TESTNET_PASSPHRASE,'RPC_NETWORK_MISMATCH');
  const contract = Address.fromString(address).toScAddress();
  requireThat(contract.switch().name==='scAddressTypeContract','CONTRACT_ADDRESS_REQUIRED');
  const instanceKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({contract,key:xdr.ScVal.scvLedgerKeyContractInstance(),durability:xdr.ContractDataDurability.persistent()}));
  const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({hash:Buffer.from(approvedHash,'hex')}));
  const result = await server.getLedgerEntries(instanceKey,codeKey);
  requireThat(Number.isSafeInteger(result.latestLedger) && result.latestLedger>0 && result.entries.length===2,'CONTRACT_CODE_UNAVAILABLE');
  const find = (key:xdr.LedgerKey)=>result.entries.find(e=>e.key.toXDR('base64')===key.toXDR('base64'));
  const instance=find(instanceKey), code=find(codeKey);
  requireThat(instance && code && instance.liveUntilLedgerSeq && code.liveUntilLedgerSeq && instance.liveUntilLedgerSeq>result.latestLedger+120 && code.liveUntilLedgerSeq>result.latestLedger+120,'CONTRACT_TTL_UNREADY');
  requireThat(instance.val.switch().name==='contractData' && code.val.switch().name==='contractCode','CONTRACT_CODE_MISMATCH');
  const data=instance.val.contractData();
  requireThat(data.contract().toXDR('base64')===contract.toXDR('base64') && data.key().switch().name==='scvLedgerKeyContractInstance' && data.val().switch().name==='scvContractInstance','CONTRACT_INSTANCE_MISMATCH');
  const executable=data.val().instance().executable();
  requireThat(executable.switch().name==='contractExecutableWasm' && executable.wasmHash().toString('hex')===approvedHash,'CONTRACT_CODE_CHANGED');
  requireThat(code.val.contractCode().hash().toString('hex')===approvedHash && hashWasm(code.val.contractCode().code())===approvedHash,'WASM_BYTES_MISMATCH');
  return {ledger:result.latestLedger,wasmHash:approvedHash};
}
/** Explicitly supplied only AFTER a reviewed deployment and independent recovery drill.
 * Failure/rotation/expiry returns no funding instructions; it never falls back to a QR.
 */
export function verifiedReceiveRoutes(store:PaymentRepository, policies:PolicyReader, server:Pick<rpc.Server,'getNetwork'|'getLedgerEntries'>, approved:ReadonlyMap<string,{accountWasmHash:string;verifierAddress:string;verifierWasmHash:string}>) {
  return async (walletId:string,owner:string) => {
    const wallet=await store.wallet(walletId,owner), deployment=approved.get(wallet.address);
    if(!deployment) return undefined;
    await verifyCurrentContractCode(server,wallet.address,deployment.accountWasmHash);
    await verifyCurrentContractCode(server,deployment.verifierAddress,deployment.verifierWasmHash);
    const policy=await policies.current(wallet.address);
    requireThat(spendingReady(policy) && policy.fingerprint===wallet.policy,'SIGNER_POLICY_CHANGED_OR_RECOVERY_UNREADY');
    return {address:wallet.address,route:'contract' as const,instructions:'Receive Testnet native XLM using a Stellar Asset Contract transfer to this verified smart-wallet address. Classic payment operations and exchange withdrawals are not supported.'};
  };
}
