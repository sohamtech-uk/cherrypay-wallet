import { createHash } from 'node:crypto';
import { Address, xdr } from '@stellar/stellar-sdk';
import { Client, type ContextRule, type Signer } from 'smart-account-kit-bindings';
import { attestAccountCode } from './onchain-code.js';
import { createTestnetRpc } from './deployment-evidence.js';
import type { ContractRuleReader, VerifiedSignerRules } from './passkey-codec.js';
import { TESTNET_PASSPHRASE, TESTNET_RPC_URL } from '../config.js';

/** Reads explicitly configured rule IDs directly from Testnet using the generated
 * contract binding. No indexer or browser-supplied signer state is trusted. */
export class TestnetContractRuleReader implements ContractRuleReader {
  constructor(private readonly ruleIds: readonly number[], private readonly verifier: string) {
    if (!ruleIds.length || ruleIds.length > 16 || new Set(ruleIds).size !== ruleIds.length ||
      ruleIds.some(id => !Number.isInteger(id) || id < 0 || id > 0xffffffff)) throw new Error('INVALID_RULE_SELECTION');
  }
  async readVerifiedRules(address: string, authEntry: xdr.SorobanAuthorizationEntry): Promise<VerifiedSignerRules> {
    const server = createTestnetRpc();
    const code = await attestAccountCode(address, server);
    const latest = await server.getLatestLedger();
    const client = new Client({ contractId: address, networkPassphrase: TESTNET_PASSPHRASE, rpcUrl: TESTNET_RPC_URL });
    const contexts: string[] = [];
    const walk = (invocation: xdr.SorobanAuthorizedInvocation) => {
      const fn = invocation.function();
      if (fn.switch().name !== 'sorobanAuthorizedFunctionTypeContractFn') throw new Error('UNSUPPORTED_AUTH_CONTEXT');
      contexts.push(Address.fromScAddress(fn.contractFn().contractAddress()).toString());
      for (const child of invocation.subInvocations()) walk(child);
    };
    walk(authEntry.rootInvocation());
    if (contexts.length !== this.ruleIds.length) throw new Error('CONTEXT_RULE_COUNT_MISMATCH');
    const rules: ContextRule[] = [];
    for (const id of this.ruleIds) {
      const tx = await client.get_context_rule({ context_rule_id: id });
      const rule = tx.result;
      if (rule.id !== id) throw new Error('CONTEXT_RULE_ID_MISMATCH');
      rules.push(rule);
    }
    const signerXdrByCredential: Record<string,string> = {};
    const credentialIds: string[] = [];
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.valid_until != null && rule.valid_until < latest.sequence) throw new Error('CONTEXT_RULE_EXPIRED');
      if (rule.context_type.tag !== 'Default' &&
          !(rule.context_type.tag === 'CallContract' && rule.context_type.values[0] === contexts[i])) throw new Error('CONTEXT_RULE_SCOPE_MISMATCH');
      if (rule.policies.length || rule.signers.length !== 1 || rule.signer_ids.length !== rule.signers.length) throw new Error('COMPLEX_SIGNER_POLICY_REQUIRES_SEPARATE_VERIFICATION');
      const signer: Signer = rule.signers[0];
      if (signer.tag !== 'External' || signer.values[0] !== this.verifier) throw new Error('NOT_WEBAUTHN_SIGNER');
      const credentialId = Buffer.from(signer.values[1]).toString('base64url');
      const signerVal = xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('External'),
        xdr.ScVal.scvVec([
          xdr.ScVal.scvAddress(Address.fromString(signer.values[0]).toScAddress()),
          xdr.ScVal.scvBytes(signer.values[1]),
        ]),
      ]);
      if (signerXdrByCredential[credentialId] && signerXdrByCredential[credentialId] !== signerVal.toXDR('base64')) throw new Error('SIGNER_COLLISION');
      signerXdrByCredential[credentialId] = signerVal.toXDR('base64');
      if (!credentialIds.includes(credentialId)) credentialIds.push(credentialId);
    }
    if (credentialIds.length !== 1) throw new Error('MULTI_SIGNER_POLICY_NOT_SUPPORTED');
    const fingerprint = createHash('sha256').update(JSON.stringify({
      address, wasmSha256: code.wasmSha256,
      rules: rules.map(r => ({ id: r.id, type: r.context_type, validUntil: r.valid_until, signerIds: r.signer_ids, policyIds: r.policy_ids, signers: r.signers.map(s => s.tag === 'External' ? [s.tag,s.values[0],Buffer.from(s.values[1]).toString('hex')] : [s.tag,s.values[0]]) }))
    })).digest('hex');
    return { address, wasmSha256: code.wasmSha256, ledger: latest.sequence, contextRuleIds: [...this.ruleIds], credentialIds, signerXdrByCredential, fingerprint };
  }
}
