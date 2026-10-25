import { generateKeyPairSync } from 'node:crypto';
import { Address, StrKey, xdr } from '@stellar/stellar-sdk';
import { Client } from 'smart-account-kit-bindings';
import { describe, expect, it, vi } from 'vitest';
import { decodeContextRule, readHydratedContextRule, signerScVal, type RawContractRead, type RuleSpec } from './context-rules.js';
import { SMART_ACCOUNT_KIT } from './kit-manifest.js';
import { TESTNET_PASSPHRASE } from '../config.js';

const account = StrKey.encodeContract(Buffer.alloc(32, 1));
const verifier = SMART_ACCOUNT_KIT.webauthnVerifierAddress;
const policy = StrKey.encodeContract(Buffer.alloc(32, 9));
const spec = new Client({ contractId: account, networkPassphrase: TESTNET_PASSPHRASE, rpcUrl: 'https://soroban-testnet.stellar.org' }).spec as unknown as RuleSpec;

function keyData(credential: string) {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x!, 'base64url'), y = Buffer.from(jwk.y!, 'base64url');
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
