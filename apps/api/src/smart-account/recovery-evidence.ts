import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { Address, Transaction, TransactionBuilder, scValToNative, xdr, type rpc } from '@stellar/stellar-sdk';
import { PASSPHRASE, requireThat } from '../payments/model.js';
import { addressCredentials, transferOperation, verifyOutcome } from '../payments/stellar.js';
import { accountChallenge, credentialKeyData, type ApprovedAccount } from './pinned-adapter.js';

export type RecoveryCredential = { id: string; public_key: string };
export type RecoveryWebAuthn = { rpID: string; origin: string };
function fields(value: xdr.ScVal, names: string[]): Map<string, xdr.ScVal> {
  requireThat(value.switch().name === 'scvMap', 'INVALID_RECOVERY_SIGNATURE');
  const entries = value.map()!;
  requireThat(entries.length === names.length && entries.every(e => e.key().switch().name === 'scvSymbol'), 'INVALID_RECOVERY_SIGNATURE');
  const result = new Map(entries.map(e => [e.key().sym().toString(), e.val()]));
  requireThat(result.size === names.length && names.every(n => result.has(n)), 'INVALID_RECOVERY_SIGNATURE');
  return result;
}
function bytes(value: xdr.ScVal): Buffer {
  requireThat(value.switch().name === 'scvBytes', 'INVALID_RECOVERY_SIGNATURE');
  return Buffer.from(value.bytes());
}

/** Checks a committed native-XLM transfer signed ONLY by this user's backup rule.
 * A trusted Testnet RPC response and already reviewed account/verifier code are
 * prerequisites. This is cryptographic backup-control evidence, not proof that
 * two authenticators are physically independent or that the primary was lost.
 * No signing, SQL writes, migration, submission or recovery-flag update occurs.
 */
export function inspectBackupRecoveryTransaction(account: ApprovedAccount, owned: readonly RecoveryCredential[], response: rpc.Api.GetTransactionResponse, webauthn: RecoveryWebAuthn) {
  const backup = owned.find(c => c.id === account.backupCredentialId);
  const primary = owned.find(c => c.id === account.primaryCredentialId);
  requireThat(backup && primary && backup.id !== primary.id && account.primaryRuleId !== account.backupRuleId, 'RECOVERY_CREDENTIALS_NOT_OWNED');
  const key = credentialKeyData(backup), primaryKey = credentialKeyData(primary);
  requireThat(!key.subarray(0, 65).equals(primaryKey.subarray(0, 65)), 'BACKUP_KEY_MUST_BE_INDEPENDENT');
  requireThat(response.status === 'SUCCESS', 'RECOVERY_TRANSACTION_NOT_CONFIRMED');
  const outcome = verifyOutcome(account.recoveryTransactionHash, response);
  requireThat(outcome.status === 'SUCCESS', 'RECOVERY_TRANSACTION_NOT_CONFIRMED');
  const tx = TransactionBuilder.fromXDR(response.envelopeXdr, PASSPHRASE);
  requireThat(tx instanceof Transaction, 'RECOVERY_ENVELOPE_UNSUPPORTED');
  const operations = tx.toEnvelope().v1().tx().operations();
  requireThat(operations.length === 1 && !operations[0].sourceAccount() && operations[0].body().switch().name === 'invokeHostFunction', 'RECOVERY_OPERATION_UNSUPPORTED');
  const op = operations[0].body().invokeHostFunctionOp();
  requireThat(op.hostFunction().switch().name === 'hostFunctionTypeInvokeContract' && op.auth().length === 1, 'RECOVERY_OPERATION_UNSUPPORTED');
  const auth = op.auth()[0], cred = addressCredentials(auth.credentials());
  requireThat(Address.fromScAddress(cred.address()).toString() === account.address && auth.rootInvocation().subInvocations().length === 0, 'RECOVERY_ACCOUNT_MISMATCH');
  requireThat(auth.rootInvocation().function().switch().name === 'sorobanAuthorizedFunctionTypeContractFn', 'RECOVERY_OPERATION_UNSUPPORTED');
  const call = op.hostFunction().invokeContract(), args = call.args();
  requireThat(args.length === 3 && args[0].switch().name === 'scvAddress' && args[1].switch().name === 'scvAddress' && args[2].switch().name === 'scvI128', 'RECOVERY_OPERATION_UNSUPPORTED');
  const from = Address.fromScVal(args[0]).toString(), to = Address.fromScVal(args[1]).toString();
  const amount = scValToNative(args[2]);
  requireThat(from === account.address && from !== to && typeof amount === 'bigint' && amount > 0n, 'RECOVERY_TRANSFER_MISMATCH');
  const expected = transferOperation(from, to, amount.toString()).body().invokeHostFunctionOp().hostFunction().invokeContract().toXDR('base64');
  requireThat(call.toXDR('base64') === expected && auth.rootInvocation().function().contractFn().toXDR('base64') === expected, 'RECOVERY_TRANSFER_MISMATCH');
  requireThat(cred.signatureExpirationLedger() >= response.ledger, 'RECOVERY_AUTH_EXPIRED');

  const payload = fields(cred.signature(), ['context_rule_ids', 'signers']);
  const rules = payload.get('context_rule_ids')!;
  requireThat(rules.switch().name === 'scvVec' && rules.vec()!.length === 1 && rules.vec()![0].switch().name === 'scvU32' && rules.vec()![0].u32() === account.backupRuleId, 'BACKUP_RULE_NOT_USED');
  const signers = payload.get('signers')!;
  requireThat(signers.switch().name === 'scvMap' && signers.map()!.length === 1, 'BACKUP_MUST_SIGN_INDEPENDENTLY');
  const signer = signers.map()![0];
  const expectedSigner = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('External'), new Address(account.verifierAddress).toScVal(), xdr.ScVal.scvBytes(key)]);
  requireThat(signer.key().toXDR('base64') === expectedSigner.toXDR('base64'), 'BACKUP_SIGNER_MISMATCH');
  const signatureData = fields(xdr.ScVal.fromXDR(bytes(signer.val())), ['authenticator_data', 'client_data', 'signature']);
  const authenticator = bytes(signatureData.get('authenticator_data')!);
  const clientData = bytes(signatureData.get('client_data')!);
  const signature = bytes(signatureData.get('signature')!);
  requireThat(authenticator.length >= 37 && clientData.length <= 1024 && signature.length === 64 && (authenticator[32] & 5) === 5, 'RECOVERY_USER_VERIFICATION_REQUIRED');
  const rpHash = createHash('sha256').update(webauthn.rpID).digest();
  requireThat(timingSafeEqual(authenticator.subarray(0, 32), rpHash), 'RECOVERY_RP_MISMATCH');
  let client: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try { client = JSON.parse(clientData.toString('utf8')); } catch { throw Error('INVALID_RECOVERY_CLIENT_DATA'); }
  requireThat(client && client.type === 'webauthn.get' && client.challenge === accountChallenge(auth, account.backupRuleId) && client.origin === webauthn.origin && (client.crossOrigin === undefined || client.crossOrigin === false), 'RECOVERY_CHALLENGE_OR_ORIGIN_MISMATCH');
  const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: key.subarray(1, 33).toString('base64url'), y: key.subarray(33, 65).toString('base64url') } });
  const message = Buffer.concat([authenticator, createHash('sha256').update(clientData).digest()]);
  requireThat(verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature), 'BACKUP_SIGNATURE_INVALID');
  const events = outcome.events.filter(e => e.from === from && e.to === to && e.amountStroops === amount.toString());
  requireThat(events.length === 1, 'RECOVERY_TRANSFER_NOT_VERIFIED');
  return { walletId: account.walletId, address: account.address, transactionHash: account.recoveryTransactionHash, ledger: response.ledger, eventId: events[0].id, backupCredentialId: backup.id, backupRuleId: account.backupRuleId, backupSpendVerified: true as const, physicalDeviceIndependenceVerified: false as const };
}

export async function readBackupRecoveryEvidence(server: Pick<rpc.Server, 'getNetwork' | 'getTransaction'>, account: ApprovedAccount, owned: readonly RecoveryCredential[], webauthn: RecoveryWebAuthn) {
  requireThat((await server.getNetwork()).passphrase === PASSPHRASE, 'RPC_NETWORK_MISMATCH');
  return inspectBackupRecoveryTransaction(account, owned, await server.getTransaction(account.recoveryTransactionHash), webauthn);
}
