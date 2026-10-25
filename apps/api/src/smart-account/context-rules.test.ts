import { generateKeyPairSync } from 'node:crypto';
import { Address, StrKey, xdr } from '@stellar/stellar-sdk';
import { Client } from 'smart-account-kit-bindings';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeContextRule, readHydratedContextRule, signerScVal, type RawContractRead, type RuleSpec } from './context-rules.js';
import { ContractRulePolicyReader, TestnetContractRuleReader, type RuleReaderRpc } from './contract-rule-reader.js';
import { SMART_ACCOUNT_KIT } from './kit-manifest.js';
import { TESTNET_PASSPHRASE } from '../config.js';

const account = StrKey.encodeContract(Buffer.alloc(32, 1));
const verifier = SMART_ACCOUNT_KIT.webauthnVerifierAddress;
const policy = StrKey.encodeContract(Buffer.alloc(32, 9));
const spec = new Client({ contractId: account, networkPassphrase: TESTNET_PASSPHRASE, rpcUrl: 'https://soroban-testnet.stellar.org' }).spec as unknown as RuleSpec;

function keyData(credential: string) {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url'), Buffer.from(credential)]);
}
const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u32s = (ids: number[]) => xdr.ScVal.scvVec(ids.map(id => xdr.ScVal.scvU32(id)));
/** get_context_rule as an older account build returns it: optionally without signer_ids/policy_ids. */
function ruleScVal(o: { id: number; key: Buffer; signerIds?: number[]; policyIds?: number[]; policies?: string[]; scope?: string; validUntil?: number }) {
  const fields: Record<string, xdr.ScVal> = {
    context_type: o.scope ? xdr.ScVal.scvVec([sym('CallContract'), new Address(o.scope).toScVal()]) : xdr.ScVal.scvVec([sym('Default')]),
    id: xdr.ScVal.scvU32(o.id),
    name: xdr.ScVal.scvString(`rule-${o.id}`),
    policies: xdr.ScVal.scvVec((o.policies ?? []).map(p => new Address(p).toScVal())),
    signers: xdr.ScVal.scvVec([xdr.ScVal.scvVec([sym('External'), new Address(verifier).toScVal(), xdr.ScVal.scvBytes(o.key)])]),
    valid_until: o.validUntil === undefined ? xdr.ScVal.scvVoid() : xdr.ScVal.scvU32(o.validUntil),
  };
  if (o.signerIds) fields.signer_ids = u32s(o.signerIds);
  if (o.policyIds) fields.policy_ids = u32s(o.policyIds);
  return xdr.ScVal.scvMap(Object.keys(fields).sort().map(k => new xdr.ScMapEntry({ key: sym(k), val: fields[k] })));
}
/** In-memory contract: rules by id, signer/policy registry keyed by canonical ScVal XDR. */
function contract(rules: Record<number, xdr.ScVal>, signerIds: Record<string, number>, policyIds: Record<string, number> = {}, ledger = 500) {
  const calls: string[] = [];
  const read: RawContractRead = vi.fn(async (fn, args) => {
    calls.push(fn);
    if (fn === 'get_context_rule') return { retval: rules[args[0].u32()], ledger };
    if (fn === 'get_signer_id') {
      const id = signerIds[args[0].toXDR('base64')];
      if (id === undefined) throw new Error('CONTRACT_READ_FAILED');
      return { retval: xdr.ScVal.scvU32(id), ledger };
    }
    if (fn === 'get_policy_id') return { retval: xdr.ScVal.scvU32(policyIds[Address.fromScVal(args[0]).toString()]), ledger };
    throw new Error('unexpected ' + fn);
  });
  return { read, calls };
}
const signerKey = (key: Buffer) => signerScVal(spec, { tag: 'External', values: [verifier, key] }).toXDR('base64');

describe('context rule decoding', () => {
  it('encodes External signers as the flat contract enum tuple', () => {
    const v = signerScVal(spec, { tag: 'External', values: [verifier, Buffer.from([1, 2])] });
    expect(v.vec()!.map(x => x.switch().name)).toEqual(['scvSymbol', 'scvAddress', 'scvBytes']);
  });
  it('decodes rules that omit signer_ids/policy_ids and reports them missing', () => {
    const { rule, missing } = decodeContextRule(spec, ruleScVal({ id: 0, key: keyData('cred') }));
    expect(missing).toEqual({ signerIds: true, policyIds: true });
    expect(rule.signers).toHaveLength(1);
    expect(rule.signer_ids).toEqual([]);
  });
  it('decodes spec-conformant rules unchanged', () => {
    const { rule, missing } = decodeContextRule(spec, ruleScVal({ id: 3, key: keyData('cred'), signerIds: [7], policyIds: [] }));
    expect(missing).toEqual({ signerIds: false, policyIds: false });
    expect(rule.signer_ids).toEqual([7]);
  });
  it('rejects non-struct results', () => {
    expect(() => decodeContextRule(spec, xdr.ScVal.scvU32(1))).toThrow('CONTEXT_RULE_NOT_A_STRUCT');
  });
});

describe('readHydratedContextRule', () => {
  it('hydrates signer and policy IDs from the contract when the getter omits them', async () => {
    const key = keyData('cred');
    const c = contract({ 0: ruleScVal({ id: 0, key, policies: [policy] }) }, { [signerKey(key)]: 42 }, { [policy]: 5 });
    const h = await readHydratedContextRule(c.read, spec, 0);
    expect(h.rule.signer_ids).toEqual([42]);
    expect(h.rule.policy_ids).toEqual([5]);
    expect(h.hydrated).toEqual({ signerIds: true, policyIds: true });
    expect(c.calls).toEqual(['get_context_rule', 'get_signer_id', 'get_policy_id']);
    expect(h.ledgers).toEqual([500, 500, 500]);
  });
  it('does not call the ID getters when the rule already carries aligned IDs', async () => {
    const c = contract({ 1: ruleScVal({ id: 1, key: keyData('c'), signerIds: [9], policyIds: [] }) }, {});
    expect((await readHydratedContextRule(c.read, spec, 1)).rule.signer_ids).toEqual([9]);
    expect(c.calls).toEqual(['get_context_rule']);
  });
  it('fails closed on misaligned, unresolvable or mismatched rules', async () => {
    const key = keyData('c');
    await expect(readHydratedContextRule(contract({ 1: ruleScVal({ id: 1, key, signerIds: [], policyIds: [] }) }, {}).read, spec, 1)).rejects.toThrow('SIGNER_IDS_MISALIGNED');
    await expect(readHydratedContextRule(contract({ 1: ruleScVal({ id: 1, key }) }, {}).read, spec, 1)).rejects.toThrow('CONTRACT_READ_FAILED');
    await expect(readHydratedContextRule(contract({ 1: ruleScVal({ id: 2, key }) }, { [signerKey(key)]: 1 }).read, spec, 1)).rejects.toThrow('CONTEXT_RULE_ID_MISMATCH');
    await expect(readHydratedContextRule(contract({}, {}).read, spec, -1)).rejects.toThrow('INVALID_RULE_SELECTION');
  });
});

describe('TestnetContractRuleReader + ContractRulePolicyReader', () => {
  const primary = keyData('primary-cred'), backup = keyData('backup-cred');
  let rules: Record<number, xdr.ScVal>, registry: Record<string, number>;
  beforeEach(() => {
    rules = { 0: ruleScVal({ id: 0, key: primary }), 1: ruleScVal({ id: 1, key: backup }) };
    registry = { [signerKey(primary)]: 10, [signerKey(backup)]: 11 };
  });
  function server(ledger = 500): RuleReaderRpc {
    const wasm = Buffer.from(SMART_ACCOUNT_KIT.accountWasmHash, 'hex');
    return {
      getNetwork: vi.fn(async () => ({ passphrase: TESTNET_PASSPHRASE, protocolVersion: 23 })),
      getLatestLedger: vi.fn(async () => ({ id: 'x', sequence: ledger, protocolVersion: 23 })),
      getContractData: vi.fn(async () => ({ val: xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({ ext: new xdr.ExtensionPoint(0), contract: new Address(account).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent(), val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(wasm), storage: [] })) })) })),
      simulateTransaction: vi.fn(async (tx: { operations: { func: xdr.HostFunction }[] }) => {
        const call = tx.operations[0].func.invokeContract();
        const fn = call.functionName().toString(), arg = call.args()[0];
        const retval = fn === 'get_context_rule' ? rules[arg.u32()] : fn === 'get_signer_id' ? xdr.ScVal.scvU32(registry[arg.toXDR('base64')]) : undefined;
        if (!retval) return { error: 'HostError', latestLedger: ledger, events: [], _parsed: true };
        return { latestLedger: ledger, minResourceFee: '1', events: [], transactionData: {} as never, result: { auth: [], retval }, _parsed: true };
      }),
    } as unknown as RuleReaderRpc;
  }
  it('hydrates IDs, derives the credential from key data and reports recovery readiness', async () => {
    const reader = new TestnetContractRuleReader({ transferRuleIds: [0], recoveryRuleId: 1, verifier }, server());
    const r = await reader.readAccountRules(account);
    expect(r.rules[0].signer_ids).toEqual([10]);
    expect(r.credentialIds).toEqual([Buffer.from('primary-cred').toString('base64url')]);
    expect(r.contextRuleIds).toEqual([0]);
    expect(r.recoveryReady).toBe(true);
    expect(xdr.ScVal.fromXDR(r.signerXdrByCredential[r.credentialIds[0]], 'base64').vec()).toHaveLength(3);
  });
  it('gives the payment-policy reader and passkey codec the same fingerprint', async () => {
    const reader = new TestnetContractRuleReader({ transferRuleIds: [0], recoveryRuleId: 1, verifier }, server());
    const policyView = await new ContractRulePolicyReader(reader).current(account);
    const codecView = await reader.readAccountRules(account);
    expect(policyView).toEqual({ fingerprint: codecView.fingerprint, recoveryReady: true });
  });
  it('changes the fingerprint when a signer is re-registered under a new ID', async () => {
    const reader = new TestnetContractRuleReader({ transferRuleIds: [0], recoveryRuleId: 1, verifier }, server());
    const before = (await reader.readAccountRules(account)).fingerprint;
    registry[signerKey(primary)] = 99;
    expect((await reader.readAccountRules(account)).fingerprint).not.toBe(before);
  });
  it('is not recovery-ready without an independent backup rule', async () => {
    expect((await new ContractRulePolicyReader(new TestnetContractRuleReader({ transferRuleIds: [0], verifier }, server())).current(account)).recoveryReady).toBe(false);
    rules[1] = ruleScVal({ id: 1, key: primary });
    await expect(new TestnetContractRuleReader({ transferRuleIds: [0], recoveryRuleId: 1, verifier }, server()).readAccountRules(account)).rejects.toThrow('BACKUP_KEY_MUST_BE_INDEPENDENT');
  });
  it('rejects wrong verifier, expired rules and invalid selections', async () => {
    const other = StrKey.encodeContract(Buffer.alloc(32, 7));
    await expect(new TestnetContractRuleReader({ transferRuleIds: [0], verifier: other }, server()).readAccountRules(account)).rejects.toThrow('NOT_WEBAUTHN_SIGNER');
    rules[0] = ruleScVal({ id: 0, key: primary, validUntil: 10 });
    await expect(new TestnetContractRuleReader({ transferRuleIds: [0], verifier }, server()).readAccountRules(account)).rejects.toThrow('CONTEXT_RULE_EXPIRED');
    expect(() => new TestnetContractRuleReader({ transferRuleIds: [0], recoveryRuleId: 0, verifier })).toThrow('INVALID_RULE_SELECTION');
    expect(() => new TestnetContractRuleReader({ transferRuleIds: [], verifier })).toThrow('INVALID_RULE_SELECTION');
  });
  it('checks the auth-entry context against the selected rule scope', async () => {
    const sac = StrKey.encodeContract(Buffer.alloc(32, 3)), elsewhere = StrKey.encodeContract(Buffer.alloc(32, 4));
    const entry = (target: string) => new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Address(target).toScAddress(), functionName: 'transfer', args: [] })), subInvocations: [] }),
    });
    rules[0] = ruleScVal({ id: 0, key: primary, scope: sac });
    const reader = new TestnetContractRuleReader({ transferRuleIds: [0], verifier }, server());
    expect((await reader.readVerifiedRules(account, entry(sac))).contextRuleIds).toEqual([0]);
    await expect(reader.readVerifiedRules(account, entry(elsewhere))).rejects.toThrow('CONTEXT_RULE_SCOPE_MISMATCH');
  });
});
