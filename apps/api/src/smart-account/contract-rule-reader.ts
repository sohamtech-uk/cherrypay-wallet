import { createHash } from 'node:crypto';
import { Address, StrKey, xdr, type rpc } from '@stellar/stellar-sdk';
import { Client, type ContextRule } from 'smart-account-kit-bindings';
import { verifyCurrentContractCode } from './receive-route.js';
import { SMART_ACCOUNT_KIT, requireApprovedAccountWasm } from './kit-manifest.js';
import { createTestnetRpc } from './deployment-evidence.js';
import { readHydratedContextRule, signerScVal, simulationReader, withConsistentSnapshot, type RuleSpec } from './context-rules.js';
import type { ContractRuleReader, VerifiedSignerRules } from './passkey-codec.js';
import type { PolicyReader } from '../payments/model.js';
import { credentialKeyData } from './pinned-adapter.js';
import { getCredentials } from '../store.js';
import { TESTNET_PASSPHRASE, TESTNET_RPC_URL } from '../config.js';

export type RuleReaderRpc = Pick<rpc.Server, 'getNetwork' | 'getLedgerEntries' | 'simulateTransaction'>;
export type RuleSelection = Readonly<{
  /** Rules committed into the transfer digest, one per auth context, in invocation order. */
  transferRuleIds: readonly number[];
  /** Optional separate Default rule holding an independent backup passkey. Without it recovery is not ready. */
  recoveryRuleId?: number;
  /** WebAuthn verifier contract that every accepted External signer must use. */
  verifier: string;
  /** Reviewed verifier WASM hash; defaults to the manifest's pinned verifier. */
  verifierWasmHash?: string;
}>;
export type VerifiedAccountRules = VerifiedSignerRules & Readonly<{
  recoveryReady: boolean;
  /** Full on-chain External key data (hex) for every accepted signer, transfer and recovery. */
  keyDataByCredential: Readonly<Record<string, string>>;
}>;

type SingleSigner = { credentialId: string; signerXdr: string; key: string; keyData: string };
const isU32 = (id: number) => Number.isInteger(id) && id >= 0 && id <= 0xffffffff;

/** Accept only a Default/CallContract rule with exactly one External verifier signer and no policies. */
function singlePasskeySigner(rule: ContextRule, verifier: string, spec: RuleSpec): SingleSigner {
  if (rule.policies.length || rule.policy_ids.length || rule.signers.length !== 1 || rule.signer_ids.length !== 1) {
    throw new Error('COMPLEX_SIGNER_POLICY_REQUIRES_SEPARATE_VERIFICATION');
  }
  const signer = rule.signers[0];
  if (signer.tag !== 'External' || signer.values[0] !== verifier) throw new Error('NOT_WEBAUTHN_SIGNER');
  const keyData = Buffer.from(signer.values[1]);
  // Smart Account Kit key data: 65-byte uncompressed P-256 public key followed by the credential ID.
  if (keyData.length <= 65 || keyData[0] !== 4) throw new Error('INVALID_WEBAUTHN_KEY_DATA');
  return {
    credentialId: keyData.subarray(65).toString('base64url'),
    signerXdr: signerScVal(spec, signer).toXDR('base64'),
    key: keyData.subarray(0, 65).toString('hex'),
    keyData: keyData.toString('hex'),
  };
}

/** Reads explicitly configured rule IDs directly from Testnet using the generated
 * contract spec, hydrating signer/policy IDs from the contract when the deployed
 * getter omits them. No indexer or browser-supplied signer state is trusted. */
export class TestnetContractRuleReader implements ContractRuleReader {
  private readonly selection: RuleSelection;
  constructor(selection: RuleSelection, private readonly server: RuleReaderRpc = createTestnetRpc()) {
    const ids = [...selection.transferRuleIds, ...(selection.recoveryRuleId === undefined ? [] : [selection.recoveryRuleId])];
    if (!selection.transferRuleIds.length || selection.transferRuleIds.length > 16 || new Set(ids).size !== ids.length || !ids.every(isU32)) throw new Error('INVALID_RULE_SELECTION');
    if (!StrKey.isValidContract(selection.verifier)) throw new Error('INVALID_VERIFIER_ADDRESS');
    this.selection = Object.freeze({ ...selection, transferRuleIds: Object.freeze([...selection.transferRuleIds]) });
  }

  /** One consistent ledger snapshot of account code, verifier code, selected rules and any
   * hydrated IDs. A snapshot that spans ledgers is discarded and the whole read retried. */
  readAccountRules(address: string): Promise<VerifiedAccountRules & { rules: readonly ContextRule[] }> {
    return withConsistentSnapshot(() => this.readSnapshot(address));
  }

  private async readSnapshot(address: string): Promise<VerifiedAccountRules & { rules: readonly ContextRule[] }> {
    const { transferRuleIds, recoveryRuleId, verifier } = this.selection;
    const accountWasmHash = SMART_ACCOUNT_KIT.accountWasmHash;
    requireApprovedAccountWasm(accountWasmHash);
    const [accountCode, verifierCode] = await Promise.all([
      verifyCurrentContractCode(this.server, address, accountWasmHash),
      verifyCurrentContractCode(this.server, verifier, this.selection.verifierWasmHash ?? SMART_ACCOUNT_KIT.webauthnVerifierWasmHash),
    ]);
    const code = { wasmSha256: accountCode.wasmHash };
    const spec = new Client({ contractId: address, networkPassphrase: TESTNET_PASSPHRASE, rpcUrl: TESTNET_RPC_URL }).spec as unknown as RuleSpec;
    const read = simulationReader(this.server, address);
    const allIds = recoveryRuleId === undefined ? transferRuleIds : [...transferRuleIds, recoveryRuleId];
    const hydrated = [];
    for (const id of allIds) hydrated.push(await readHydratedContextRule(read, spec, id));
    // Code, rules and hydrated IDs must all be observed at the same ledger.
    const snapshot = accountCode.ledger;
    if (![verifierCode.ledger, ...hydrated.flatMap(h => h.ledgers)].every(l => l === snapshot)) throw new Error('INCONSISTENT_POLICY_SNAPSHOT');
    const latest = { sequence: snapshot };
    const rules = hydrated.map(h => h.rule);
    for (const rule of rules) {
      if (rule.valid_until != null && rule.valid_until < latest.sequence) throw new Error('CONTEXT_RULE_EXPIRED');
    }
    const transferRules = rules.slice(0, transferRuleIds.length);
    const signers = transferRules.map(rule => singlePasskeySigner(rule, verifier, spec));
    const credentialIds = [...new Set(signers.map(s => s.credentialId))];
    if (credentialIds.length !== 1) throw new Error('MULTI_SIGNER_POLICY_NOT_SUPPORTED');
    const signerXdrByCredential: Record<string, string> = { [credentialIds[0]]: signers[0].signerXdr };
    if (signers.some(s => s.signerXdr !== signers[0].signerXdr)) throw new Error('SIGNER_COLLISION');
    let recoveryReady = false;
    const keyDataByCredential: Record<string, string> = { [credentialIds[0]]: signers[0].keyData };
    if (recoveryRuleId !== undefined) {
      const recoveryRule = rules[rules.length - 1];
      if (recoveryRule.context_type.tag !== 'Default' || recoveryRule.valid_until != null) throw new Error('UNSUPPORTED_RECOVERY_RULE');
      const backup = singlePasskeySigner(recoveryRule, verifier, spec);
      if (backup.credentialId === credentialIds[0] || backup.key === signers[0].key) throw new Error('BACKUP_KEY_MUST_BE_INDEPENDENT');
      keyDataByCredential[backup.credentialId] = backup.keyData;
      recoveryReady = true;
    }
    // Hydrated IDs are part of the fingerprint: a signer removed and re-added gets a new
    // registry ID, which must invalidate any outstanding approval.
    const fingerprint = createHash('sha256').update(JSON.stringify({
      address, wasmSha256: code.wasmSha256, recoveryRuleId: recoveryRuleId ?? null,
      rules: rules.map(r => ({ id: r.id, type: r.context_type, validUntil: r.valid_until ?? null, signerIds: r.signer_ids, policyIds: r.policy_ids, signers: r.signers.map(s => s.tag === 'External' ? [s.tag, s.values[0], Buffer.from(s.values[1]).toString('hex')] : [s.tag, s.values[0]]) })),
    })).digest('hex');
    return { address, wasmSha256: code.wasmSha256, ledger: snapshot, contextRuleIds: [...transferRuleIds], credentialIds, signerXdrByCredential, fingerprint, recoveryReady, keyDataByCredential, rules: transferRules };
  }

  async readVerifiedRules(address: string, authEntry: xdr.SorobanAuthorizationEntry): Promise<VerifiedSignerRules> {
    const contexts: string[] = [];
    const walk = (invocation: xdr.SorobanAuthorizedInvocation) => {
      const fn = invocation.function();
      if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') throw new Error('UNSUPPORTED_AUTH_CONTEXT');
      contexts.push(Address.fromScAddress(fn.contractFn().contractAddress()).toString());
      for (const child of invocation.subInvocations()) walk(child);
    };
    walk(authEntry.rootInvocation());
    if (contexts.length !== this.selection.transferRuleIds.length) throw new Error('CONTEXT_RULE_COUNT_MISMATCH');
    const { rules, recoveryReady: _recovery, keyDataByCredential: _keys, ...verified } = await this.readAccountRules(address);
    rules.forEach((rule, i) => {
      if (rule.context_type.tag !== 'Default' &&
          !(rule.context_type.tag === 'CallContract' && rule.context_type.values[0] === contexts[i])) throw new Error('CONTEXT_RULE_SCOPE_MISMATCH');
    });
    return verified;
  }
}

export type CredentialSource = (owner: string) => Promise<{ id: string; public_key: string }[]>;
/** Payment-policy reader backed by the same on-chain rule snapshot as StellarPasskeyCodec,
 * so the fingerprint stored at prepare time is exactly what the codec re-checks at approval.
 * Every on-chain passkey (transfer and recovery) must be a credential the wallet owner
 * registered with Cherry Pay, with byte-identical public key data. */
export class ContractRulePolicyReader implements PolicyReader {
  constructor(private readonly reader: TestnetContractRuleReader, private readonly owners: ReadonlyMap<string, string>, private readonly credentials: CredentialSource = getCredentials) {}
  async current(address: string): Promise<{ fingerprint: string; recoveryReady: boolean }> {
    const owner = this.owners.get(address);
    if (!owner) throw new Error('UNAPPROVED_ACCOUNT');
    const [{ fingerprint, recoveryReady, keyDataByCredential }, owned] = await Promise.all([this.reader.readAccountRules(address), this.credentials(owner)]);
    for (const [credentialId, keyData] of Object.entries(keyDataByCredential)) {
      const stored = owned.find(c => c.id === credentialId);
      if (!stored) throw new Error('ONCHAIN_CREDENTIAL_NOT_OWNED');
      if (credentialKeyData(stored).toString('hex') !== keyData) throw new Error('ONCHAIN_SIGNER_KEY_MISMATCH');
    }
    return { fingerprint, recoveryReady };
  }
}
