import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Account, Address, StrKey, TransactionBuilder, nativeToScVal, xdr, type rpc } from '@stellar/stellar-sdk';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { expect, it, vi } from 'vitest';
import { ACCOUNT_V080_HASH, accountChallenge, credentialKeyData, encodeAccountAssertion, type ApprovedAccount } from './pinned-adapter.js';
import { inspectBackupRecoveryTransaction, readBackupRecoveryEvidence } from './recovery-evidence.js';
import { addressCredentials, transferOperation } from '../payments/stellar.js';
import { NATIVE_SAC, PASSPHRASE } from '../payments/model.js';

// Synthetic key/signature + RPC fixtures. No physical authenticator or live
// transaction is claimed by this suite; it tests evidence validation boundaries.
function key(name: string) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]);
  return { ...pair, credential: { id: Buffer.from(name).toString('base64url'), public_key: Buffer.from(isoCBOR.encode(cose)).toString('base64') } };
}
function fixture(options: { primary?: boolean; corrupt?: boolean; wrongEvent?: boolean } = {}) {
  const primary = key('primary-device'), backup = key('backup-device');
  const address = StrKey.encodeContract(Buffer.alloc(32, 10)), verifier = StrKey.encodeContract(Buffer.alloc(32, 11));
  const destination = StrKey.encodeContract(Buffer.alloc(32, 12));
  const account: ApprovedAccount = { walletId: 'alice-wallet', owner: 'alice', address, accountWasmHash: ACCOUNT_V080_HASH, verifierAddress: verifier, verifierWasmHash: 'a'.repeat(64), primaryRuleId: 1, backupRuleId: 2, primaryCredentialId: primary.credential.id, backupCredentialId: backup.credential.id, deploymentTransactionHash: 'b'.repeat(64), recoveryTransactionHash: 'c'.repeat(64) };
  const op = transferOperation(address, destination, '1');
  const entry = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: new Address(address).toScAddress(), nonce: xdr.Int64.fromString('123'), signatureExpirationLedger: 150, signature: xdr.ScVal.scvVoid() })), rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(op.body().invokeHostFunctionOp().hostFunction().invokeContract()), subInvocations: [] }) });
  const signer = options.primary ? primary : backup, ruleId = options.primary ? 1 : 2;
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: accountChallenge(entry, ruleId), origin: 'https://wallet.example', crossOrigin: false }));
  const authData = Buffer.concat([createHash('sha256').update('wallet.example').digest(), Buffer.from([5]), Buffer.from([0, 0, 0, 1])]);
  const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(client).digest()]), signer.privateKey);
  const assertion = { id: signer.credential.id, rawId: signer.credential.id, type: 'public-key' as const, clientExtensionResults: {}, response: { authenticatorData: authData.toString('base64url'), clientDataJSON: client.toString('base64url'), signature: signature.toString('base64url') } };
  const signed = xdr.SorobanAuthorizationEntry.fromXDR(encodeAccountAssertion(entry, ruleId, { tag: 'External', values: [verifier, credentialKeyData(signer.credential)] }, assertion), 'base64');
  if (options.corrupt) {
    const payload = addressCredentials(signed.credentials()).signature();
    const signerEntry = payload.map()!.find(e => e.key().sym().toString() === 'signers')!.val().map()![0];
    const data = xdr.ScVal.fromXDR(signerEntry.val().bytes());
    data.map()!.find(e => e.key().sym().toString() === 'signature')!.val(xdr.ScVal.scvBytes(Buffer.alloc(64, 9)));
    signerEntry.val(xdr.ScVal.scvBytes(data.toXDR()));
  }
  op.body().invokeHostFunctionOp().auth([signed]);
  const tx = new TransactionBuilder(new Account(StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 5)), '1'), { fee: '100', networkPassphrase: PASSPHRASE }).addOperation(op).setTimeout(120).build();
  const hash = tx.hash().toString('hex');
  const event = new xdr.ContractEvent({ ext: new xdr.ExtensionPoint(0), contractId: StrKey.decodeContract(NATIVE_SAC) as unknown as xdr.Hash, type: xdr.ContractEventType.contract(), body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics: [xdr.ScVal.scvSymbol('transfer'), new Address(address).toScVal(), new Address(destination).toScVal()], data: nativeToScVal(options.wrongEvent ? 2n : 1n, { type: 'i128' }) })) });
  const response = { status: 'SUCCESS', txHash: hash, ledger: 100, createdAt: 1, envelopeXdr: tx.toEnvelope(), resultXdr: new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString('100'), result: xdr.TransactionResultResult.txSuccess([]), ext: new xdr.TransactionResultExt(0) }), events: { contractEventsXdr: [[event]], transactionEventsXdr: [] } } as unknown as rpc.Api.GetTransactionResponse;
  return { account: { ...account, recoveryTransactionHash: hash }, owned: [primary.credential, backup.credential], response, webauthn: { rpID: 'wallet.example', origin: 'https://wallet.example' } };
}
it('accepts a cryptographically valid backup-only committed spend without claiming physical independence', () => {
  const f = fixture();
  expect(inspectBackupRecoveryTransaction(f.account, f.owned, f.response, f.webauthn)).toMatchObject({ walletId: f.account.walletId, transactionHash: f.account.recoveryTransactionHash, backupCredentialId: f.account.backupCredentialId, backupRuleId: 2, backupSpendVerified: true, physicalDeviceIndependenceVerified: false });
});
it('rejects a primary-signed transaction presented as backup recovery', () => {
  const f = fixture({ primary: true });
  expect(() => inspectBackupRecoveryTransaction(f.account, f.owned, f.response, f.webauthn)).toThrow('BACKUP_RULE_NOT_USED');
});
it('independently verifies the actual backup signature even when the supplied response says SUCCESS', () => {
  const f = fixture({ corrupt: true });
  expect(() => inspectBackupRecoveryTransaction(f.account, f.owned, f.response, f.webauthn)).toThrow('BACKUP_SIGNATURE_INVALID');
});
it('requires the exact independently verified native-XLM event', () => {
  const f = fixture({ wrongEvent: true });
  expect(() => inspectBackupRecoveryTransaction(f.account, f.owned, f.response, f.webauthn)).toThrow('RECOVERY_TRANSFER_NOT_VERIFIED');
});
it('rejects another user, a missing backup, or two IDs using the same public key', () => {
  const f = fixture();
  expect(() => inspectBackupRecoveryTransaction(f.account, [f.owned[0]], f.response, f.webauthn)).toThrow('RECOVERY_CREDENTIALS_NOT_OWNED');
  expect(() => inspectBackupRecoveryTransaction({ ...f.account, backupCredentialId: 'someone-else' }, f.owned, f.response, f.webauthn)).toThrow('RECOVERY_CREDENTIALS_NOT_OWNED');
  const shared = [f.owned[0], { ...f.owned[1], public_key: f.owned[0].public_key }];
  expect(() => inspectBackupRecoveryTransaction(f.account, shared, f.response, f.webauthn)).toThrow('BACKUP_KEY_MUST_BE_INDEPENDENT');
});
it('rejects a different transaction, RP ID or website origin', () => {
  const f = fixture();
  expect(() => inspectBackupRecoveryTransaction({ ...f.account, recoveryTransactionHash: 'd'.repeat(64) }, f.owned, f.response, f.webauthn)).toThrow('TRANSACTION_HASH_MISMATCH');
  expect(() => inspectBackupRecoveryTransaction(f.account, f.owned, f.response, { ...f.webauthn, rpID: 'attacker.example' })).toThrow('RECOVERY_RP_MISMATCH');
  expect(() => inspectBackupRecoveryTransaction(f.account, f.owned, f.response, { ...f.webauthn, origin: 'https://attacker.example' })).toThrow('RECOVERY_CHALLENGE_OR_ORIGIN_MISMATCH');
});
it('never treats NOT_FOUND or a failed transaction as recovery evidence', () => {
  const f = fixture();
  for (const status of ['NOT_FOUND', 'FAILED']) expect(() => inspectBackupRecoveryTransaction(f.account, f.owned, { ...f.response, status } as rpc.Api.GetTransactionResponse, f.webauthn)).toThrow('RECOVERY_TRANSACTION_NOT_CONFIRMED');
});
it('checks the network before looking up evidence and never broadcasts', async () => {
  const f = fixture();
  const server = { getNetwork: vi.fn(async () => ({ passphrase: 'Public Global Stellar Network ; September 2015' })), getTransaction: vi.fn(async () => f.response) };
  await expect(readBackupRecoveryEvidence(server as unknown as Pick<rpc.Server, 'getNetwork' | 'getTransaction'>, f.account, f.owned, f.webauthn)).rejects.toThrow('RPC_NETWORK_MISMATCH');
  expect(server.getTransaction).not.toHaveBeenCalled();
});
