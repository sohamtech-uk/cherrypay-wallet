import { Account, Address, Keypair, Operation, StrKey, TransactionBuilder, xdr, type rpc } from '@stellar/stellar-sdk';
import { expect, it, vi } from 'vitest';
import { deploymentAddress, inspectDeploymentTransaction, verifyTestnetDeployment } from './deployment-evidence.js';
import { TESTNET_PASSPHRASE } from '../config.js';
import { ACCOUNT_V080_HASH } from './pinned-adapter.js';
function fixture() {
  const payer = Keypair.random().publicKey();
  const op = Operation.createCustomContract({ address: new Address(payer), wasmHash: Buffer.from(ACCOUNT_V080_HASH,'hex'), salt: Buffer.alloc(32,7), constructorArgs: [] });
  const tx = new TransactionBuilder(new Account(payer,'1'), { fee:'100', networkPassphrase:TESTNET_PASSPHRASE }).addOperation(op).setTimeout(120).build();
  const txHash = tx.hash().toString('hex');
  const address = deploymentAddress(op.body().invokeHostFunctionOp().hostFunction().createContractV2().contractIdPreimage());
  const evidence = { contractAddress:address, wasmSha256:ACCOUNT_V080_HASH, deploymentTransactionHash:txHash, sourceCommit:'d'.repeat(40) };
  const response = { status:'SUCCESS', txHash, ledger:100, envelopeXdr:tx.toEnvelope(), resultXdr:new xdr.TransactionResult({ feeCharged:xdr.Int64.fromString('100'), result:xdr.TransactionResultResult.txSuccess([]), ext:new xdr.TransactionResultExt(0) }) } as unknown as rpc.Api.GetTransactionResponse;
  return { evidence,response };
}
it('binds the committed deployment to its network-derived address and executable', () => {
  const f = fixture(); expect(inspectDeploymentTransaction(f.evidence,f.response)).toMatchObject({ contractAddress:f.evidence.contractAddress, ledger:100 });
});
it('rejects an unrelated successful transaction offered as deployment evidence', () => {
  const f = fixture(); expect(() => inspectDeploymentTransaction({ ...f.evidence, contractAddress:StrKey.encodeContract(Buffer.alloc(32,8)) },f.response)).toThrow('DEPLOYMENT_ADDRESS_NOT_CREATED');
});
it('rejects a different WASM, transaction hash, or failed result', () => {
  const f = fixture();
  expect(() => inspectDeploymentTransaction({ ...f.evidence, wasmSha256:'a'.repeat(64) },f.response)).toThrow('DEPLOYMENT_WASM_MISMATCH');
  expect(() => inspectDeploymentTransaction(f.evidence,{ ...f.response, txHash:'a'.repeat(64) } as rpc.Api.GetTransactionResponse)).toThrow('DEPLOYMENT_NOT_CONFIRMED');
  expect(() => inspectDeploymentTransaction(f.evidence,{ ...f.response, status:'FAILED' } as rpc.Api.GetTransactionResponse)).toThrow('DEPLOYMENT_NOT_CONFIRMED');
  if (f.response.status === 'SUCCESS') f.response.resultXdr.result(xdr.TransactionResultResult.txBadSeq());
  expect(() => inspectDeploymentTransaction(f.evidence,f.response)).toThrow('DEPLOYMENT_RESULT_MISMATCH');
});
it('rejects a forged envelope even if the RPC fields claim the expected hash', () => {
  const f = fixture(), other = fixture();
  expect(() => inspectDeploymentTransaction(f.evidence,{ ...f.response, envelopeXdr:(other.response as rpc.Api.GetSuccessfulTransactionResponse).envelopeXdr } as rpc.Api.GetTransactionResponse)).toThrow('DEPLOYMENT_ENVELOPE_MISMATCH');
});
it('checks Testnet before requesting any deployment evidence', async () => {
  const f = fixture(), server = { getNetwork:vi.fn(async () => ({ passphrase:'mainnet' })), getTransaction:vi.fn(async () => f.response) };
  await expect(verifyTestnetDeployment(f.evidence,server as unknown as Pick<rpc.Server,'getNetwork'|'getTransaction'>)).rejects.toThrow('RPC_NETWORK_MISMATCH');
  expect(server.getTransaction).not.toHaveBeenCalled();
});
