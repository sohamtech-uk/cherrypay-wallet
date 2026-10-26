import { createHash } from 'node:crypto';
import { Account, Address, Contract, StrKey, TransactionBuilder, buildAuthorizationEntryPreimage, hash, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { Client, type Signer } from 'smart-account-kit-bindings';
import { decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON } from '@simplewebauthn/types';
import { getCredentials } from '../store.js';
import { PASSPHRASE, requireThat, type Attempt, type PolicyReader, type Wallet } from '../payments/model.js';
import { addressCredentials, assertTransferAuthorization } from '../payments/stellar.js';
import type { ContractPasskeyCodec } from '../payments/passkey-approval.js';
import { verifyCurrentContractCode } from './receive-route.js';
import { readHydratedContextRule, simulationReader, withConsistentSnapshot, type HydratedContextRule, type RawContractRead, type RuleSpec } from './context-rules.js';

// Source-reviewed ABI: OpenZeppelin/stellar-contracts v0.8.0 at ddc327eb92d63709436da3a8455f641c2d5476c5.
// Hash identified by upstream Smart Account Kit's auth-digest-scheme.ts.
// The npm 0.8.0 digest helper uses an older format and MUST NOT encode this account.
export const ACCOUNT_V080_HASH = 'c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1';
export type ApprovedAccount = Readonly<{
  walletId: string; owner: string; address: string;
  accountWasmHash: typeof ACCOUNT_V080_HASH; verifierAddress: string; verifierWasmHash: string;
  primaryRuleId: number; backupRuleId: number;
  primaryCredentialId: string; backupCredentialId: string;
  // Operator-supplied references to reviewed deployment and completed two-device recovery evidence.
  deploymentTransactionHash: string; recoveryTransactionHash: string;
}>;
type PublicCredential = { id: string; public_key: string };
export type AccountRpc = Pick<rpc.Server,'getNetwork'|'getLedgerEntries'|'simulateTransaction'>;
const sha = (s:string)=>createHash('sha256').update(s).digest('hex');
const map = (fields:Record<string,xdr.ScVal>)=>xdr.ScVal.scvMap(Object.keys(fields).sort().map(key=>new xdr.ScMapEntry({key:xdr.ScVal.scvSymbol(key),val:fields[key]})));
const bytes = (value:Uint8Array)=>xdr.ScVal.scvBytes(Buffer.from(value));
const readTransaction=(address:string,name:string,args:xdr.ScVal[])=>new TransactionBuilder(new Account(StrKey.encodeEd25519PublicKey(Buffer.alloc(32)), '0'),{fee:'100',networkPassphrase:PASSPHRASE}).addOperation(new Contract(address).call(name,...args)).setTimeout(30).build();

export function credentialKeyData(credential: PublicCredential): Buffer {
  const cose=decodeCredentialPublicKey(new Uint8Array(Buffer.from(credential.public_key,'base64'))) as Map<number, unknown>;
  const x=cose.get(-2),y=cose.get(-3);
  requireThat(cose.get(1)===2 && cose.get(3)===-7 && cose.get(-1)===1 && x instanceof Uint8Array && y instanceof Uint8Array && x.length===32 && y.length===32,'P256_CREDENTIAL_REQUIRED');
  const id=Buffer.from(credential.id,'base64url');
  requireThat(id.length>0 && id.length<=959 && id.toString('base64url')===credential.id,'INVALID_CREDENTIAL_ID');
  return Buffer.concat([Buffer.from([4]),x,y,id]);
}
/** Strict DER integers, range checks and Stellar-required low-S normalization. */
export function compactP256(der:Buffer):Buffer {
  requireThat(der.length>=8 && der.length<=72 && der[0]===0x30 && der[1]===der.length-2,'INVALID_DER_SIGNATURE');
  let offset=2;
  const component=()=>{
    requireThat(der[offset++]===2,'INVALID_DER_SIGNATURE');const length=der[offset++];
    requireThat(length>=1 && length<=33 && offset+length<=der.length,'INVALID_DER_SIGNATURE');
    const b=der.subarray(offset,offset+length);offset+=length;
    requireThat(!(b[0]&0x80) && !(length>1 && b[0]===0 && !(b[1]&0x80)),'NONCANONICAL_DER_SIGNATURE');
    return BigInt('0x'+b.toString('hex'));
  };
  const r=component();let s=component();const n=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  requireThat(offset===der.length && r>0n && r<n && s>0n && s<n,'INVALID_DER_SIGNATURE');
  if(s>n/2n)s=n-s;
  return Buffer.concat([Buffer.from(r.toString(16).padStart(64,'0'),'hex'),Buffer.from(s.toString(16).padStart(64,'0'),'hex')]);
}
export function accountDigestPreimage(entry:xdr.SorobanAuthorizationEntry,ruleId:number):xdr.ScVal {
  const credentials=addressCredentials(entry.credentials());
  requireThat(Number.isInteger(ruleId) && ruleId>=0 && ruleId<=0xffffffff && credentials.signatureExpirationLedger()>0,'INVALID_RULE_OR_EXPIRATION');
  const signaturePayload=hash(buildAuthorizationEntryPreimage(entry,credentials.signatureExpirationLedger(),PASSPHRASE).toXDR());
  return map({account:xdr.ScVal.scvAddress(credentials.address()),context_rule_ids:xdr.ScVal.scvVec([xdr.ScVal.scvU32(ruleId)]),signature_payload:bytes(signaturePayload)});
}
export function accountChallenge(entry:xdr.SorobanAuthorizationEntry,ruleId:number):string {return hash(accountDigestPreimage(entry,ruleId).toXDR()).toString('base64url');}
export function encodeAccountAssertion(entry:xdr.SorobanAuthorizationEntry,ruleId:number,signer:Signer,assertion:AuthenticationResponseJSON):string {
  requireThat(signer.tag==='External','EXTERNAL_SIGNER_REQUIRED');
  const client=Buffer.from(assertion.response.clientDataJSON,'base64url'),auth=Buffer.from(assertion.response.authenticatorData,'base64url');
  requireThat(client.length<=1024 && auth.length>=37 && (auth[32]&5)===5,'INVALID_CONTRACT_ASSERTION');
  const data=JSON.parse(client.toString('utf8'));
  requireThat(data.type==='webauthn.get' && data.challenge===accountChallenge(entry,ruleId),'CONTRACT_CHALLENGE_MISMATCH');
  const signature=compactP256(Buffer.from(assertion.response.signature,'base64url'));
  const sigData=map({authenticator_data:bytes(auth),client_data:bytes(client),signature:bytes(signature)}).toXDR();
  const signerVal=xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('External'),new Address(signer.values[0]).toScVal(),bytes(signer.values[1])]);
  const signed=xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  addressCredentials(signed.credentials()).signature(map({context_rule_ids:xdr.ScVal.scvVec([xdr.ScVal.scvU32(ruleId)]),signers:xdr.ScVal.scvMap([new xdr.ScMapEntry({key:signerVal,val:bytes(sigData)})])}));
  return signed.toXDR('base64');
}

/** Two permanent, separate Default rules: each has exactly one owned P-256 signer
 * and no policies. No delegation, threshold, session key or rule discovery fallback.
 */
export class PinnedAccountAdapter implements PolicyReader, ContractPasskeyCodec {
  private approved:ReadonlyMap<string,ApprovedAccount>;
  constructor(private server:AccountRpc,accounts:readonly ApprovedAccount[],private credentials:(owner:string)=>Promise<PublicCredential[]>=getCredentials) {
    requireThat(new Set(accounts.map(a=>a.address)).size===accounts.length,'DUPLICATE_APPROVED_ACCOUNT');
    for(const a of accounts)requireThat(a.accountWasmHash===ACCOUNT_V080_HASH && StrKey.isValidContract(a.address) && StrKey.isValidContract(a.verifierAddress) && /^[a-f0-9]{64}$/.test(a.verifierWasmHash) && /^[a-f0-9]{64}$/.test(a.deploymentTransactionHash) && /^[a-f0-9]{64}$/.test(a.recoveryTransactionHash) && a.deploymentTransactionHash!==a.recoveryTransactionHash && a.primaryCredentialId!==a.backupCredentialId && a.primaryRuleId!==a.backupRuleId && [a.primaryRuleId,a.backupRuleId].every(id=>Number.isInteger(id)&&id>=0&&id<=0xffffffff),'INVALID_APPROVED_ACCOUNT');
    this.approved=new Map(accounts.map(a=>[a.address,Object.freeze({...a})]));
  }
  private read(address:string) {return withConsistentSnapshot(()=>this.readSnapshot(address));}
  private async readSnapshot(address:string) {
    const a=this.approved.get(address);requireThat(a,'UNAPPROVED_ACCOUNT');
    const [accountCode,verifierCode]=await Promise.all([verifyCurrentContractCode(this.server,address,a.accountWasmHash),verifyCurrentContractCode(this.server,a.verifierAddress,a.verifierWasmHash)]);
    const spec=new Client({contractId:address,networkPassphrase:PASSPHRASE,rpcUrl:'https://soroban-testnet.stellar.org'}).spec as unknown as RuleSpec;
    const read=simulationReader(this.server,address);
    const minLedger=Math.max(accountCode.ledger,verifierCode.ledger);
    const fresh:RawContractRead=async(fn,args)=>{const r=await read(fn,args);requireThat(r.ledger>=minLedger,'STALE_POLICY_READ');return r;};
    const [countRead,primary,backup,owned]=await Promise.all([fresh('get_context_rules_count',[]),readHydratedContextRule(fresh,spec,a.primaryRuleId),readHydratedContextRule(fresh,spec,a.backupRuleId),this.credentials(a.owner)]);
    const count=spec.funcResToNative('get_context_rules_count',countRead.retval.toXDR('base64'));
    // Never combine code, rules and hydrated IDs observed at different ledger snapshots.
    const snapshot=primary.ledgers[0];
    requireThat([accountCode.ledger,verifierCode.ledger,countRead.ledger,...primary.ledgers,...backup.ledgers].every(ledger=>ledger===snapshot),'INCONSISTENT_POLICY_SNAPSHOT');
    requireThat(count===2,'UNEXPECTED_ACCOUNT_RULES');
    const check=(response:HydratedContextRule,id:number,credentialId:string)=>{
      const rule=response.rule;
      requireThat(rule.id===id && rule.context_type.tag==='Default' && rule.valid_until==null && rule.policies.length===0 && rule.policy_ids.length===0 && rule.signers.length===1 && rule.signer_ids.length===1,'UNSUPPORTED_ACCOUNT_POLICY');
      const credential=owned.find(c=>c.id===credentialId);requireThat(credential,'ONCHAIN_CREDENTIAL_NOT_OWNED');
      const expected=credentialKeyData(credential),signer=rule.signers[0];
      requireThat(signer.tag==='External' && signer.values[0]===a.verifierAddress && Buffer.from(signer.values[1]).equals(expected),'ONCHAIN_SIGNER_KEY_MISMATCH');
      return {rule,credentialId,signer,key:expected.subarray(0,65)};
    };
    const p=check(primary,a.primaryRuleId,a.primaryCredentialId),b=check(backup,a.backupRuleId,a.backupCredentialId);
    requireThat(!p.key.equals(b.key),'BACKUP_KEY_MUST_BE_INDEPENDENT');
    // Raw getter output is fingerprinted as returned. IDs resolved separately (older account
    // builds omit them from get_context_rule) are appended so signer re-registration is detected.
    const ids=(h:HydratedContextRule)=>h.hydrated.signerIds||h.hydrated.policyIds?[h.rule.signer_ids,h.rule.policy_ids]:[];
    const hydratedIds=[...ids(primary),...ids(backup)];
    const fingerprint=sha(JSON.stringify([PASSPHRASE,address,a.accountWasmHash,a.verifierAddress,a.verifierWasmHash,primary.raw,backup.raw,...(hydratedIds.length?[hydratedIds]:[])]));
    return {approved:a,primary:p,backup:b,fingerprint,ledger:snapshot};
  }
  async current(address:string) {const state=await this.read(address);return {fingerprint:state.fingerprint,recoveryReady:true};}
  private async context(wallet:Wallet,attempt:Attempt) {
    const state=await this.read(wallet.address);
    requireThat(state.approved.owner===wallet.owner && state.approved.walletId===wallet.id && attempt.walletId===wallet.id && attempt.from===wallet.address && state.fingerprint===wallet.policy && state.fingerprint===attempt.policy,'ACCOUNT_POLICY_BINDING_CHANGED');
    requireThat(attempt.prepared && attempt.prepared.expiresAt>Date.now(),'QUOTE_EXPIRED');
    const entry=xdr.SorobanAuthorizationEntry.fromXDR(attempt.prepared.authXdr,'base64');assertTransferAuthorization(entry,wallet,attempt.intent);
    const cred=addressCredentials(entry.credentials());
    requireThat(cred.signature().switch().name==='scvVoid' && cred.signatureExpirationLedger()===attempt.prepared.expirationLedger && state.ledger<cred.signatureExpirationLedger(),'INVALID_PREPARED_AUTHORIZATION');
    // v0.8.0's pure helper checks the wire format against the actual pinned code.
    // No signature is requested if contract and local digest disagree.
    const checked=await this.server.simulateTransaction(readTransaction(wallet.address,'auth_digest',[accountDigestPreimage(entry,state.primary.rule.id)]),undefined,'enforce');
    requireThat(rpc.Api.isSimulationSuccess(checked) && !rpc.Api.isSimulationRestore(checked) && checked.result && checked.result.auth.length===0 && checked.latestLedger===state.ledger,'ACCOUNT_DIGEST_CHECK_UNAVAILABLE');
    const digest=scValToNative(checked.result.retval);
    requireThat(Buffer.isBuffer(digest) && digest.length===32 && digest.toString('base64url')===accountChallenge(entry,state.primary.rule.id),'ACCOUNT_DIGEST_MISMATCH');
    return {...state,entry};
  }
  async describe(wallet:Wallet,attempt:Attempt) {
    const state=await this.context(wallet,attempt);
    // Normal sends use the primary rule; recovery uses a separate, explicit ceremony.
    return {challenge:accountChallenge(state.entry,state.primary.rule.id),credentialIds:[state.primary.credentialId],policy:state.fingerprint};
  }
  async encode(wallet:Wallet,attempt:Attempt,assertion:AuthenticationResponseJSON) {
    const state=await this.context(wallet,attempt);
    requireThat(assertion.id===state.primary.credentialId,'UNAUTHORIZED_TRANSFER_CREDENTIAL');
    return encodeAccountAssertion(state.entry,state.primary.rule.id,state.primary.signer,assertion);
  }
}
