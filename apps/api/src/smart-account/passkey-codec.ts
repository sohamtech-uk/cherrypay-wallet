import { createHash } from 'node:crypto';
import { Address, buildAuthorizationEntryPreimage, hash, xdr } from '@stellar/stellar-sdk';
import type { AuthenticationResponseJSON } from '@simplewebauthn/types';
import type { Attempt, Wallet } from '../payments/model.js';
import type { ContractPasskeyCodec, SigningPlan } from '../payments/passkey-approval.js';
import { attestAccountCode } from './onchain-code.js';
import { createTestnetRpc } from './deployment-evidence.js';
import { SMART_ACCOUNT_KIT } from './kit-manifest.js';
import { TESTNET_PASSPHRASE } from '../config.js';

export type VerifiedSignerRules = Readonly<{
  address: string;
  wasmSha256: string;
  ledger: number;
  contextRuleIds: readonly number[];
  credentialIds: readonly string[];
  /** Canonical contract Signer ScVal XDR keyed by credential ID. */
  signerXdrByCredential: Readonly<Record<string,string>>;
  fingerprint: string;
}>;
/** Implementations MUST query active rules and signer IDs from the contract,
 * decode using version-matched bindings, and verify a confirmed ledger.
 * Never construct this from a browser request, indexer alone, or local credentials. */
export interface ContractRuleReader {
  readVerifiedRules(address: string, authEntry: xdr.SorobanAuthorizationEntry): Promise<VerifiedSignerRules>;
}
function authEntry(attempt: Attempt): xdr.SorobanAuthorizationEntry {
  if (!attempt.prepared?.authXdr) throw new Error('AUTH_ENTRY_NOT_PREPARED');
  return xdr.SorobanAuthorizationEntry.fromXDR(attempt.prepared.authXdr, 'base64');
}
function addressCredentials(entry: xdr.SorobanAuthorizationEntry) {
  if (entry.credentials().switch().name !== 'sorobanCredentialsAddressV2') throw new Error('V2_AUTH_CREDENTIALS_REQUIRED');
  return entry.credentials().addressV2();
}
function verifiedPlan(wallet: Wallet, attempt: Attempt, rules: VerifiedSignerRules) {
  const entry = authEntry(attempt);
  const credentials = addressCredentials(entry);
  if (Address.fromScAddress(credentials.address()).toString() !== wallet.address ||
      rules.address !== wallet.address ||
      rules.wasmSha256 !== SMART_ACCOUNT_KIT.accountWasmHash ||
      rules.fingerprint !== attempt.policy ||
      !Number.isSafeInteger(rules.ledger) || rules.ledger <= 0 ||
      !rules.contextRuleIds.length || !rules.credentialIds.length ||
      new Set(rules.contextRuleIds).size !== rules.contextRuleIds.length ||
      rules.contextRuleIds.some(id => !Number.isInteger(id) || id < 0 || id > 0xffffffff) ||
      new Set(rules.credentialIds).size !== rules.credentialIds.length) throw new Error('UNVERIFIED_SIGNER_RULES');
  const expiry = credentials.signatureExpirationLedger();
  if (!expiry || attempt.prepared!.expiresAt <= Date.now()) throw new Error('AUTH_ENTRY_EXPIRED');
  const signaturePayload = hash(buildAuthorizationEntryPreimage(entry, expiry, TESTNET_PASSPHRASE).toXDR());
  // stellar-accounts 0.7.3: legacy-concat; never use with preimage-v1 WASM.
  const digest = hash(Buffer.concat([signaturePayload, xdr.ScVal.scvVec(rules.contextRuleIds.map(id => xdr.ScVal.scvU32(id))).toXDR()]));
  return { entry, credentials, digest, plan: { challenge: digest.toString('base64url'), credentialIds: [...rules.credentialIds], policy: rules.fingerprint } satisfies SigningPlan };
}
function compactP256(der: Buffer): Buffer {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error('INVALID_P256_DER');
  let pos = 2;
  const parts: Buffer[] = [];
  for (let n = 0; n < 2; n++) {
    if (der[pos++] !== 2) throw new Error('INVALID_P256_DER');
    const len = der[pos++];
    if (!len || len > 33 || pos + len > der.length) throw new Error('INVALID_P256_DER');
    const raw = der.subarray(pos, pos + len); pos += len;
    const trimmed = raw[0] === 0 ? raw.subarray(1) : raw;
    if (trimmed.length > 32) throw new Error('INVALID_P256_DER');
    parts.push(Buffer.concat([Buffer.alloc(32 - trimmed.length), trimmed]));
  }
  if (pos !== der.length) throw new Error('INVALID_P256_DER');
  return Buffer.concat(parts);
}
const field = (name: string, value: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val: value });
/** Fail-closed bridge for a contract-specific rule reader. Not activated in app.ts. */
export class StellarPasskeyCodec implements ContractPasskeyCodec {
  constructor(private readonly rules: ContractRuleReader) {}
  private async context(wallet: Wallet, attempt: Attempt) {
    const rpc = createTestnetRpc();
    await attestAccountCode(wallet.address, rpc);
    const entry = authEntry(attempt);
    const rules = await this.rules.readVerifiedRules(wallet.address, entry);
    return { ...verifiedPlan(wallet, attempt, rules), rules };
  }
  async describe(wallet: Wallet, attempt: Attempt): Promise<SigningPlan> {
    return (await this.context(wallet, attempt)).plan;
  }
  async encode(wallet: Wallet, attempt: Attempt, assertion: AuthenticationResponseJSON): Promise<string> {
    const { entry, credentials, digest, rules } = await this.context(wallet, attempt);
    if (!rules.credentialIds.includes(assertion.id)) throw new Error('SIGNER_NOT_AUTHORIZED_ONCHAIN');
    const client = Buffer.from(assertion.response.clientDataJSON, 'base64url');
    let parsed: { type?: string; challenge?: string };
    try { parsed = JSON.parse(client.toString('utf8')); } catch { throw new Error('INVALID_WEBAUTHN_CLIENT_DATA'); }
    if (parsed.type !== 'webauthn.get' || parsed.challenge !== digest.toString('base64url')) throw new Error('WEBAUTHN_DIGEST_MISMATCH');
    const signerXdr = rules.signerXdrByCredential[assertion.id];
    if (!signerXdr) throw new Error('MISSING_ONCHAIN_SIGNER');
    const signer = xdr.ScVal.fromXDR(signerXdr, 'base64');
    const sig = xdr.ScVal.scvMap([
      field('authenticator_data', xdr.ScVal.scvBytes(Buffer.from(assertion.response.authenticatorData, 'base64url'))),
      field('client_data', xdr.ScVal.scvBytes(client)),
      field('signature', xdr.ScVal.scvBytes(compactP256(Buffer.from(assertion.response.signature, 'base64url')))),
    ]);
    if (credentials.signature().switch().name !== 'scvVoid') throw new Error('PREEXISTING_SIGNATURE_NOT_SUPPORTED');
    credentials.signature(xdr.ScVal.scvMap([
      field('context_rule_ids', xdr.ScVal.scvVec(rules.contextRuleIds.map(id => xdr.ScVal.scvU32(id)))),
      field('signers', xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: signer, val: xdr.ScVal.scvBytes(sig.toXDR()) })])),
    ]));
    return entry.toXDR('base64');
  }
}
