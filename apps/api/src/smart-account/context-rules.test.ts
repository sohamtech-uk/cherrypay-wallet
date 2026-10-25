import { generateKeyPairSync } from 'node:crypto';
import { Address, StrKey, xdr } from '@stellar/stellar-sdk';
import { Client } from 'smart-account-kit-bindings';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const code = vi.hoisted(() => ({ ledger: 500 }));
vi.mock('./receive-route.js', () => ({ verifyCurrentContractCode: vi.fn(async (_server: unknown, _address: string, wasmHash: string) => ({ ledger: code.ledger, wasmHash })) }));
import { decodeContextRule, readHydratedContextRule, signerScVal, type RawContractRead, type RuleSpec } from './context-rules.js';
import { ContractRulePolicyReader, TestnetContractRuleReader, type RuleReaderRpc } from './contract-rule-reader.js';
import { SMART_ACCOUNT_KIT } from './kit-manifest.js';
import { TESTNET_PASSPHRASE } from '../config.js';

const account = StrKey.encodeContract(Buffer.alloc(32, 1));
const verifier = SMART_ACCOUNT_KIT.webauthnVerifierAddress;
const policy = StrKey.encodeContract(Buffer.alloc(32, 9));
const spec = new Client({ contractId: account, networkPassphrase: TESTNET_PASSPHRASE, rpcUrl: 'https://soroban-testnet.stellar.org' }).spec as unknown as RuleSpec;

const stored = new Map<string, { id: string; public_key: string }>();
function keyData(credential: string) {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x!, 'base64url'), y = Buffer.from(jwk.y!, 'base64url');
  const cose = new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, x], [-3, y]]);
  const id = Buffer.from(credential).toString('base64url');
  stored.set(id, { id, public_key: Buffer.from(isoCBOR.encode(cose)).toString('base64') });
  return Buffer.concat([Buffer.from([4]), x, y, Buffer.from(credential)]);
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

const owner = 'owner-1';
let ownedIds: string[] = [];
const credentials = vi.fn(async (o: string) => (o === owner ? ownedIds.map(id => stored.get(id)!).filter(Boolean) : []));
const policyReader = (reader: TestnetContractRuleReader) => new ContractRulePolicyReader(reader, new Map([[account, owner]]), credentials);

describe('TestnetContractRuleReader + ContractRulePolicyReader', () => {
  const primary = keyData('primary-cred'), backup = keyData('backup-cred');
  let rules: Record<number, xdr.ScVal>, registry: Record<string, number>;
  beforeEach(() => {
    code.ledger = 500;
    rules = { 0: ruleScVal({ id: 0, key: primary }), 1: ruleScVal({ id: 1, key: backup }) };
    registry = { [signerKey(primary)]: 10, [signerKey(backup)]: 11 };
    ownedIds = ['primary-cred', 'backup-cred'].map(c => Buffer.from(c).toString('base64url'));
  });
  /** simLedgers: ledger reported by each successive simulation (last value repeats). */
  function server(ledger = 500, simLedgers: number[] = []): RuleReaderRpc {
    let call = 0;
    return {
      simulateTransaction: vi.fn(async (tx: { operations: { func: xdr.HostFunction }[] }) => {
        const latestLedger = simLedgers.length ? simLedgers[Math.min(call++, simLedgers.length - 1)] : ledger;
        const invoke = tx.operations[0].func.invokeContract();
        const fn = invoke.functionName().toString(), arg = invoke.args()[0];
        const retval = fn === 'get_context_rule' ? rules[arg.u32()] : fn === 'get_signer_id' ? xdr.ScVal.scvU32(registry[arg.toXDR('base64')]) : undefined;
        if (!retval) return { error: 'HostError', latestLedger, events: [], _parsed: true };
        return { latestLedger, minResourceFee: '1', events: [], transactionData: {} as never, result: { auth: [], retval }, _parsed: true };
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
    const policyView = await policyReader(reader).current(account);
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
    expect((await policyReader(new TestnetContractRuleReader({ transferRuleIds: [0], verifier }, server())).current(account)).recoveryReady).toBe(false);
    rules[1] = ruleScVal({ id: 1, key: primary });
    await expect(new TestnetContractRuleReader({ transferRuleIds: [0], recoveryRuleId: 1, verifier }, server()).readAccountRules(account)).rejects.toThrow('BACKUP_KEY_MUST_BE_INDEPENDENT');
  });
  it('requires every on-chain passkey to be an owned credential with identical key data', async () => {
    const reader = new TestnetContractRuleReader({ transferRuleIds: [0], recoveryRuleId: 1, verifier }, server());
    ownedIds = [ownedIds[0]];
    await expect(policyReader(reader).current(account)).rejects.toThrow('ONCHAIN_CREDENTIAL_NOT_OWNED');
    ownedIds = ['primary-cred', 'backup-cred'].map(c => Buffer.from(c).toString('base64url'));
    const realPrimary = stored.get(ownedIds[0])!;
    keyData('primary-cred'); // re-registers the same credential ID with a different key
    await expect(policyReader(reader).current(account)).rejects.toThrow('ONCHAIN_SIGNER_KEY_MISMATCH');
    stored.set(realPrimary.id, realPrimary);
    await expect(new ContractRulePolicyReader(reader, new Map(), credentials).current(account)).rejects.toThrow('UNAPPROVED_ACCOUNT');
    await expect(policyReader(reader).current(account)).resolves.toMatchObject({ recoveryReady: true });
  });
  it('retries a read whose code, rule and hydrated-ID observations span ledgers', async () => {
    // First attempt: rule at 500, hydrated signer ID at 501 -> discarded; second attempt consistent.
    const rpc = server(500, [500, 501, 500]);
    const r = await new TestnetContractRuleReader({ transferRuleIds: [0], verifier }, rpc).readAccountRules(account);
    expect(r.ledger).toBe(500);
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(4);
  });
  it('fails closed when no consistent snapshot can be observed', async () => {
    code.ledger = 499;
    await expect(new TestnetContractRuleReader({ transferRuleIds: [0], verifier }, server(500)).readAccountRules(account)).rejects.toThrow('INCONSISTENT_POLICY_SNAPSHOT');
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
