import { afterEach, describe, expect, it, vi } from 'vitest';
import { Account, Address, Keypair, SorobanDataBuilder, Transaction, hash, scValToNative, xdr } from '@stellar/stellar-sdk';
import { Client, type ContextRule } from 'smart-account-kit-bindings';
import { TESTNET_PASSPHRASE, TESTNET_RPC_URL } from '../config.js';
import { TESTNET_V080 } from './kit-v080-preflight.js';
import { verifyCurrentContractCode } from './receive-route.js';
import { deploymentFixture } from './test-support/deployment.js';
import { StellarDeploymentChain, assertDeploymentEnvelope, deploymentDescriptor, deploymentFunction, derivedDeploymentAddress, validateDeploymentDescriptor, type DeploymentRpc } from './automatic-deployment-chain.js';

vi.mock('./receive-route.js', () => ({ verifyCurrentContractCode: vi.fn(async () => ({ ledger: 200, wasmHash: TESTNET_V080.accountWasmHash })) }));
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const f = deploymentFixture();
  const server = {
    getNetwork: vi.fn(async () => ({ passphrase: String(TESTNET_PASSPHRASE) })),
    getAccount: vi.fn(async () => new Account(f.deployer.publicKey(), '10')),
    getLedgerEntries: vi.fn(async () => ({ entries: [], latestLedger: 200 })),
    simulateTransaction: vi.fn(async (_tx: Transaction) => ({ _parsed: true, id: 'simulation', latestLedger: 200, events: [], minResourceFee: '500', transactionData: new SorobanDataBuilder().setResourceFee('500'), result: { auth: [], retval: new Address(f.descriptor.address).toScVal() } })),
    sendTransaction: vi.fn(), getTransaction: vi.fn(),
  };
  const chain = new StellarDeploymentChain(server as unknown as DeploymentRpc, f.deployer, 100000000n);
  return { ...f, server, chain };
}

describe('real XDR deployment construction with synthetic keys', () => {
  it('derives one stable C-address from the owner, verified key, pinned code and dedicated deployer', () => {
    const f = fixture(), d = f.descriptor;
    expect(deploymentDescriptor(f.owner, f.credential, f.deployer.publicKey())).toEqual(d);
    const create = deploymentFunction(d).createContractV2();
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({ networkId: hash(Buffer.from(TESTNET_PASSPHRASE)), contractIdPreimage: create.contractIdPreimage() }));
    expect(Address.contract(hash(preimage.toXDR())).toString()).toBe(d.address);
    expect(derivedDeploymentAddress(f.deployer.publicKey(), d.saltHex)).toBe(d.address);
    expect(deploymentDescriptor('11111111-1111-4111-8111-111111111111', f.credential, f.deployer.publicKey()).address).not.toBe(d.address);
    expect(deploymentDescriptor(f.owner, f.credential, Keypair.random().publicKey()).address).not.toBe(d.address);
  });
  it('installs exactly the owner passkey, not the deployer or a two-key all-of rule', () => {
    const f = fixture(), create = deploymentFunction(f.descriptor).createContractV2();
    expect(create.executable().wasmHash().toString('hex')).toBe(TESTNET_V080.accountWasmHash);
    const args = create.constructorArgs();
    expect(args).toHaveLength(2);
    const signers = args[0].vec()!;
    expect(signers).toHaveLength(1);
    const decoded = scValToNative(signers[0]) as [string,string,Uint8Array];
    expect(decoded).toHaveLength(3);
    expect(decoded.slice(0,2)).toEqual(['External', TESTNET_V080.verifierAddress]);
    expect(Buffer.from(decoded[2]).toString('hex')).toBe(f.descriptor.keyDataHex);
    expect(args[1].map()).toHaveLength(0);
    expect(f.descriptor.keyDataHex).toContain(Buffer.from(f.credential.id,'base64url').toString('hex'));
    for (const change of [{ network: 'PUBLIC' }, { address: TESTNET_V080.verifierAddress }, { keyDataHex: '04' }, { accountWasmHash: 'a'.repeat(64) }]) {
      expect(() => validateDeploymentDescriptor({ ...f.descriptor, ...change } as typeof f.descriptor)).toThrow();
    }
  });
  it('builds and signs CreateContractV2 but never submits during preparation', async () => {
    const f = fixture(); vi.spyOn(f.chain,'preflight').mockResolvedValue();
    const result = await f.chain.prepare(f.descriptor), tx = new Transaction(result.signedXdr, TESTNET_PASSPHRASE);
    expect(tx.operations).toHaveLength(1); expect(tx.source).toBe(f.deployer.publicKey());
    expect(f.deployer.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
    expect(tx.hash().toString('hex')).toBe(result.transactionHash);
    expect(f.server.simulateTransaction).toHaveBeenCalledWith(expect.any(Transaction),undefined,'enforce');
    expect(f.server.sendTransaction).not.toHaveBeenCalled();
    assertDeploymentEnvelope(tx, f.descriptor);
    const envelope = tx.toEnvelope();
    envelope.v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().createContractV2().constructorArgs([xdr.ScVal.scvVec([]),xdr.ScVal.scvMap([])]);
    expect(() => assertDeploymentEnvelope(new Transaction(envelope, TESTNET_PASSPHRASE), f.descriptor)).toThrow('CONSTRUCTOR_CHANGED');
  });
  it('refuses mainnet, missing uploaded code and fees above the configured ceiling', async () => {
    const f = fixture(); f.server.getNetwork.mockResolvedValueOnce({passphrase:'Public Global Stellar Network ; September 2015'});
    await expect(f.chain.preflight()).rejects.toThrow('DEPLOYMENT_TESTNET_REQUIRED');
    await expect(f.chain.preflight()).rejects.toThrow('PINNED_DEPLOYMENT_WASM_UNAVAILABLE');
    const small = new StellarDeploymentChain(f.server as unknown as DeploymentRpc, f.deployer, 100n);
    vi.spyOn(small,'preflight').mockResolvedValue();
    await expect(small.prepare(f.descriptor)).rejects.toThrow('FEE_CAP');
    expect(f.server.sendTransaction).not.toHaveBeenCalled();
  });
  it('submits only the persisted signed envelope and preserves uncertain error outcomes', async () => {
    const f = fixture(); vi.spyOn(f.chain,'preflight').mockResolvedValue();
    const p = await f.chain.prepare(f.descriptor);
    f.server.sendTransaction.mockResolvedValue({ hash:p.transactionHash, status:'PENDING' });
    await f.chain.submit(f.descriptor,p);
    expect(f.server.sendTransaction.mock.calls[0][0].toXDR()).toBe(p.signedXdr);
    await expect(f.chain.submit(f.descriptor,{...p,transactionHash:'f'.repeat(64)})).rejects.toThrow('SIGNED_DEPLOYMENT_CHANGED');
    f.server.sendTransaction.mockResolvedValue({ hash:p.transactionHash, status:'TRY_AGAIN_LATER' });
    await expect(f.chain.submit(f.descriptor,p)).rejects.toThrow('UNRESOLVED');
  });
});

function policyFixture() {
  const f = fixture(), d = f.descriptor;
  const spec = new Client({ contractId:d.address,networkPassphrase:TESTNET_PASSPHRASE,rpcUrl:TESTNET_RPC_URL }).spec;
  const rule: ContextRule = { id:0,name:'multisig',context_type:{tag:'Default',values:undefined},signers:[{tag:'External',values:[d.verifierAddress,Buffer.from(d.keyDataHex,'hex')]}],signer_ids:[0],policies:[],policy_ids:[],valid_until:undefined };
  let count = 1;
  f.server.simulateTransaction.mockImplementation(async (tx: Transaction) => {
    const name = tx.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().invokeContract().functionName().toString();
    const retval = name === 'get_context_rules_count' ? xdr.ScVal.scvU32(count) : spec.nativeToScVal(rule,xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({name:'ContextRule'})));
    return { _parsed:true,id:'policy',latestLedger:200,events:[],minResourceFee:'0',transactionData:new SorobanDataBuilder(),result:{auth:[],retval} };
  });
  return {...f,rule,setCount:(value:number)=>{count=value;}};
}
describe('independent deployment and primary-signer evidence', () => {
  it('requires exactly one permanent default rule with the exact owner credential bytes', async () => {
    const f = policyFixture();
    await f.chain.verifyBinding(f.descriptor,199);
    expect(verifyCurrentContractCode).toHaveBeenCalledWith(f.server,f.descriptor.address,TESTNET_V080.accountWasmHash);
    f.rule.signers[0] = {tag:'External',values:[f.descriptor.verifierAddress,Buffer.alloc(97)]};
    await expect(f.chain.verifyBinding(f.descriptor,199)).rejects.toThrow('DEPLOYED_PASSKEY_BINDING_MISMATCH');
  });
  it('rejects extra rules, expired rules and delegated authority', async () => {
    const f = policyFixture(); f.setCount(2);
    await expect(f.chain.verifyBinding(f.descriptor,199)).rejects.toThrow('BINDING_MISMATCH');
    f.setCount(1); f.rule.valid_until=999;
    await expect(f.chain.verifyBinding(f.descriptor,199)).rejects.toThrow('BINDING_MISMATCH');
    f.rule.valid_until=undefined; f.rule.signers=[{tag:'Delegated',values:[f.deployer.publicKey()]}];
    await expect(f.chain.verifyBinding(f.descriptor,199)).rejects.toThrow('BINDING_MISMATCH');
  });
  it('recomputes the confirmed hash and verifies the resulting account before returning CONFIRMED', async () => {
    const f = fixture(); vi.spyOn(f.chain,'preflight').mockResolvedValue();
    const p = await f.chain.prepare(f.descriptor), tx = new Transaction(p.signedXdr,TESTNET_PASSPHRASE);
    const verify = vi.spyOn(f.chain,'verifyBinding').mockResolvedValue();
    f.server.getTransaction.mockResolvedValue({status:'NOT_FOUND'});
    expect(await f.chain.outcome(f.descriptor,p)).toEqual({status:'NOT_FOUND'}); expect(verify).not.toHaveBeenCalled();
    const response = { status:'SUCCESS',txHash:p.transactionHash,ledger:200,envelopeXdr:tx.toEnvelope(),resultXdr:new xdr.TransactionResult({feeCharged:xdr.Int64.fromString('100'),result:xdr.TransactionResultResult.txSuccess([]),ext:new xdr.TransactionResultExt(0)}) };
    f.server.getTransaction.mockResolvedValue(response);
    expect(await f.chain.outcome(f.descriptor,p)).toEqual({status:'CONFIRMED',ledger:200,signerRuleId:0});
    expect(verify).toHaveBeenCalledWith(f.descriptor,200);
    f.server.getTransaction.mockResolvedValue({...response,txHash:'d'.repeat(64)});
    await expect(f.chain.outcome(f.descriptor,p)).rejects.toThrow('CONFIRMATION_HASH_MISMATCH');
    f.server.getTransaction.mockResolvedValue(response); verify.mockRejectedValue(Error('Untrusted contract key'));
    await expect(f.chain.outcome(f.descriptor,p)).rejects.toThrow('Untrusted contract key');
  });
});
