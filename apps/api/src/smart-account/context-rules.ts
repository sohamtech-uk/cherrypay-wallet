import { Account, Contract, StrKey, TransactionBuilder, rpc, xdr } from '@stellar/stellar-sdk';
import type { ContextRule, Signer } from 'smart-account-kit-bindings';
import { TESTNET_PASSPHRASE } from '../config.js';

/** The generated bindings spec is the source of truth for ContextRule/Signer encoding. */
export type RuleSpec = {
  funcResToNative(name: string, value: string): unknown;
  funcArgsToScVals(name: string, args: object): xdr.ScVal[];
};
export type RuleReadFunction = 'get_context_rule' | 'get_context_rules_count' | 'get_signer_id' | 'get_policy_id';
/** A read-only contract call. Returns the raw return value and the ledger it was observed at. */
export type RawContractRead = (fn: RuleReadFunction, args: xdr.ScVal[]) => Promise<{ retval: xdr.ScVal; ledger: number }>;
export type HydratedContextRule = Readonly<{
  rule: ContextRule;
  /** Raw get_context_rule return value (base64 XDR), exactly as the contract returned it. */
  raw: string;
  /** True when signer_ids/policy_ids were absent from the getter and resolved via get_signer_id/get_policy_id. */
  hydrated: Readonly<{ signerIds: boolean; policyIds: boolean }>;
  /** Every ledger observed while reading and hydrating this rule. */
  ledgers: readonly number[];
}>;

const ID_FIELDS = ['signer_ids', 'policy_ids'] as const;
const isU32 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

/** Simulation-only reader with a fixed zero source account: no signing, no auth, no restore. */
export function simulationReader(server: Pick<rpc.Server, 'simulateTransaction'>, address: string): RawContractRead {
  if (!StrKey.isValidContract(address)) throw new Error('INVALID_CONTRACT_ADDRESS');
  const source = new Account(StrKey.encodeEd25519PublicKey(Buffer.alloc(32)), '0');
  return async (fn, args) => {
    const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: TESTNET_PASSPHRASE })
      .addOperation(new Contract(address).call(fn, ...args)).setTimeout(30).build();
    const result = await server.simulateTransaction(tx, undefined, 'enforce');
    if (!rpc.Api.isSimulationSuccess(result) || rpc.Api.isSimulationRestore(result) || !result.result || result.result.auth.length !== 0) {
      throw new Error(fn === 'get_context_rule' ? 'CONTEXT_RULE_READ_FAILED' : 'CONTRACT_READ_FAILED');
    }
    if (!Number.isSafeInteger(result.latestLedger) || result.latestLedger <= 0) throw new Error('CONTRACT_READ_LEDGER_INVALID');
    return { retval: result.result.retval, ledger: result.latestLedger };
  };
}

/** Decode get_context_rule. Deployed account builds may omit signer_ids/policy_ids;
 * those fields are injected as empty vectors only so the spec can decode the rest,
 * and are reported as missing so the caller MUST hydrate them from the contract. */
export function decodeContextRule(spec: RuleSpec, retval: xdr.ScVal): { rule: ContextRule; missing: { signerIds: boolean; policyIds: boolean } } {
  if (retval.switch().name !== 'scvMap') throw new Error('CONTEXT_RULE_NOT_A_STRUCT');
  const entries = retval.map() ?? [];
  const keys = entries.map(e => {
    if (e.key().switch().name !== 'scvSymbol') throw new Error('CONTEXT_RULE_NOT_A_STRUCT');
    return e.key().sym().toString();
  });
  if (new Set(keys).size !== keys.length) throw new Error('CONTEXT_RULE_DUPLICATE_FIELD');
  const missing = { signerIds: !keys.includes('signer_ids'), policyIds: !keys.includes('policy_ids') };
  let toDecode = retval;
  if (missing.signerIds || missing.policyIds) {
    const injected = [...entries];
    for (const field of ID_FIELDS) {
      if (!keys.includes(field)) injected.push(new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(field), val: xdr.ScVal.scvVec([]) }));
    }
    // Struct maps are ordered by bytewise symbol order; the spec decodes positionally.
    // Never use localeCompare here: locale collation can reorder policies/policy_ids.
    injected.sort((a, b) => {
      const x = a.key().sym().toString(), y = b.key().sym().toString();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    toDecode = xdr.ScVal.scvMap(injected);
  }
  const rule = spec.funcResToNative('get_context_rule', toDecode.toXDR('base64')) as ContextRule;
  if (!rule || !isU32(rule.id) || !Array.isArray(rule.signers) || !Array.isArray(rule.policies) ||
      !Array.isArray(rule.signer_ids) || !Array.isArray(rule.policy_ids)) throw new Error('CONTEXT_RULE_DECODE_FAILED');
  return { rule, missing };
}

/** Canonical contract encoding of a Signer, produced by the generated spec. */
export function signerScVal(spec: RuleSpec, signer: Signer): xdr.ScVal {
  const [value] = spec.funcArgsToScVals('get_signer_id', { signer });
  if (!value) throw new Error('SIGNER_ENCODING_FAILED');
  return value;
}

async function resolveIds<T>(items: readonly T[], lookup: (item: T) => Promise<{ retval: xdr.ScVal; ledger: number }>, spec: RuleSpec, fn: 'get_signer_id' | 'get_policy_id', ledgers: number[]) {
  const ids: number[] = [];
  for (const item of items) {
    const { retval, ledger } = await lookup(item);
    ledgers.push(ledger);
    const id = spec.funcResToNative(fn, retval.toXDR('base64'));
    if (!isU32(id)) throw new Error(fn === 'get_signer_id' ? 'SIGNER_ID_UNRESOLVED' : 'POLICY_ID_UNRESOLVED');
    ids.push(id);
  }
  return ids;
}

/** Read a context rule and resolve signer/policy registry IDs from the same contract.
 * IDs are never accepted from a browser, an indexer or local state. Present-but-misaligned
 * ID vectors are rejected rather than repaired. */
export async function readHydratedContextRule(read: RawContractRead, spec: RuleSpec, contextRuleId: number): Promise<HydratedContextRule> {
  if (!isU32(contextRuleId)) throw new Error('INVALID_RULE_SELECTION');
  const { retval, ledger } = await read('get_context_rule', [xdr.ScVal.scvU32(contextRuleId)]);
  const { rule, missing } = decodeContextRule(spec, retval);
  if (rule.id !== contextRuleId) throw new Error('CONTEXT_RULE_ID_MISMATCH');
  if (!missing.signerIds && rule.signer_ids.length !== rule.signers.length) throw new Error('SIGNER_IDS_MISALIGNED');
  if (!missing.policyIds && rule.policy_ids.length !== rule.policies.length) throw new Error('POLICY_IDS_MISALIGNED');
  const ledgers = [ledger];
  const signerIds = missing.signerIds
    ? await resolveIds(rule.signers, s => read('get_signer_id', [signerScVal(spec, s)]), spec, 'get_signer_id', ledgers)
    : rule.signer_ids;
  const policyIds = missing.policyIds
    ? await resolveIds(rule.policies, p => read('get_policy_id', spec.funcArgsToScVals('get_policy_id', { policy: p })), spec, 'get_policy_id', ledgers)
    : rule.policy_ids;
  if (new Set(signerIds).size !== signerIds.length) throw new Error('DUPLICATE_SIGNER_ID');
  if (new Set(policyIds).size !== policyIds.length) throw new Error('DUPLICATE_POLICY_ID');
  return {
    rule: { ...rule, signer_ids: [...signerIds], policy_ids: [...policyIds], valid_until: rule.valid_until ?? undefined },
    raw: retval.toXDR('base64'),
    hydrated: missing,
    ledgers,
  };
}
