import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Account, Address, SorobanDataBuilder, StrKey, TransactionBuilder, buildAuthorizationEntryPreimage, hash, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { Client, type ContextRule, type Signer } from 'smart-account-kit-bindings';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { ACCOUNT_V080_HASH, PinnedAccountAdapter, accountChallenge, compactP256, credentialKeyData, encodeAccountAssertion, type ApprovedAccount, type PrimaryAccount, type AccountRpc } from './pinned-adapter.js';
import { addressCredentials, bindAuthorization, transferOperation } from '../payments/stellar.js';
import { PASSPHRASE, type Attempt } from '../payments/model.js';
import { intent, wallet, destination } from '../payments/test-fixtures.js';
import { verifyCurrentContractCode } from './receive-route.js';
vi.mock('./receive-route.js',()=>({verifyCurrentContractCode:vi.fn(async()=>({ledger:100,wasmHash:ACCOUNT_V080_HASH}))}));
beforeEach(()=>vi.clearAllMocks());
const verifier=StrKey.encodeContract(Buffer.alloc(32,8));
function key(id:string) {
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'});
  const cose=new Map<number,number|Uint8Array>([[1,2],[3,-7],[-1,1],[-2,Buffer.from(jwk.x!,'base64url')],[-3,Buffer.from(jwk.y!,'base64url')]]);
  return {...pair,credential:{id:Buffer.from(id).toString('base64url'),public_key:Buffer.from(isoCBOR.encode(cose)).toString('base64')}};
}
function entry(v2=false) {
  const credentials=new xdr.SorobanAddressCredentials({address:new Address(wallet.address).toScAddress(),nonce:xdr.Int64.fromString('123'),signatureExpirationLedger:130,signature:xdr.ScVal.scvVoid()});
  return new xdr.SorobanAuthorizationEntry({credentials:v2?xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials):xdr.SorobanCredentials.sorobanCredentialsAddress(credentials),rootInvocation:new xdr.SorobanAuthorizedInvocation({function:xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(transferOperation(wallet.address,destination,intent.amountStroops).body().invokeHostFunctionOp().hostFunction().invokeContract()),subInvocations:[]})});
}
function assertion(k:ReturnType<typeof key>,challenge:string) {
  const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge,origin:'https://wallet.example'}));
  const auth=Buffer.concat([createHash('sha256').update('wallet.example').digest(),Buffer.from([5]),Buffer.from([0,0,0,1])]);
  const message=Buffer.concat([auth,createHash('sha256').update(client).digest()]);
  return {message,value:{id:k.credential.id,rawId:k.credential.id,type:'public-key' as const,clientExtensionResults:{},response:{authenticatorData:auth.toString('base64url'),clientDataJSON:client.toString('base64url'),signature:sign('sha256',message,k.privateKey).toString('base64url')}}};
}
it.each([false,true])('matches the v0.8.0 Rust struct layout for V2=%s and preserves exact authorization',v2=>{
  const e=entry(v2),digest=accountChallenge(e,7);
  // OpenZeppelin v0.8.0 auth_entries.rs::auth_digest_matches_off_chain_encoding.
  // This is a source-layout test, not a claim of live WASM execution.
  const expected=nativeToScVal({account:Address.fromScAddress(addressCredentials(e.credentials()).address()),context_rule_ids:[7],signature_payload:hash(buildAuthorizationEntryPreimage(e,130,PASSPHRASE).toXDR())},{type:{account:['symbol',null],context_rule_ids:['symbol','u32'],signature_payload:['symbol',null]}});
  expect(digest).toBe(hash(expected.toXDR()).toString('base64url'));
  const k=key('primary'),a=assertion(k,digest),signer:Signer={tag:'External',values:[verifier,credentialKeyData(k.credential)]};
  const signed=xdr.SorobanAuthorizationEntry.fromXDR(encodeAccountAssertion(e,7,signer,a.value),'base64');
  const payload=addressCredentials(signed.credentials()).signature();
  const data=payload.map()!.find(x=>x.key().sym().toString()==='signers')!.val().map()![0].val().bytes();
  const decoded=scValToNative(xdr.ScVal.fromXDR(data));
  expect(verify('sha256',a.message,{key:k.publicKey,dsaEncoding:'ieee-p1363'},decoded.signature)).toBe(true);
  expect(scValToNative(payload).context_rule_ids).toEqual([7]);
  const spec=new Client({contractId:wallet.address,networkPassphrase:PASSPHRASE,rpcUrl:'https://soroban-testnet.stellar.org'}).spec;
  const fromBindings=spec.nativeToScVal({context_rule_ids:[7],signers:new Map([[signer,Buffer.from(data)]])},xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({name:'AuthPayload'})));
  expect(payload.toXDR('base64')).toBe(fromBindings.toXDR('base64'));
  const op=transferOperation(wallet.address,destination,intent.amountStroops);op.body().invokeHostFunctionOp().auth([e]);
  const tx=new TransactionBuilder(new Account(StrKey.encodeEd25519PublicKey(Buffer.alloc(32,5)),'1'),{fee:'100',networkPassphrase:PASSPHRASE}).addOperation(op).setTimeout(120).build();
  expect(bindAuthorization(wallet,intent,{authXdr:e.toXDR('base64'),transactionXdr:tx.toXDR(),feeStroops:'100',ledger:100,expirationLedger:130,expiresAt:Date.now()+60000},signed.toXDR('base64')).operations).toHaveLength(1);
  addressCredentials(signed.credentials()).signature(xdr.ScVal.scvVoid());expect(signed.toXDR('base64')).toBe(e.toXDR('base64'));
});
it('binds credential version, address, rule, nonce, expiry and payment amount into the digest',()=>{
  const original=entry(true),expected=accountChallenge(original,1);
  expect(accountChallenge(entry(false),1)).not.toBe(expected);expect(accountChallenge(original,2)).not.toBe(expected);
  for(const mutate of [(e:xdr.SorobanAuthorizationEntry)=>addressCredentials(e.credentials()).nonce(xdr.Int64.fromString('124')),(e:xdr.SorobanAuthorizationEntry)=>addressCredentials(e.credentials()).signatureExpirationLedger(131),(e:xdr.SorobanAuthorizationEntry)=>addressCredentials(e.credentials()).address(new Address(verifier).toScAddress()),(e:xdr.SorobanAuthorizationEntry)=>e.rootInvocation().function().contractFn().args()[2]=xdr.ScVal.scvI128(new xdr.Int128Parts({hi:xdr.Int64.fromString('0'),lo:xdr.Uint64.fromString('2')}))]) {
    const e=entry(true);mutate(e);expect(accountChallenge(e,1)).not.toBe(expected);
  }
});
it('rejects malformed and noncanonical DER signatures and normalizes high S',()=>{
  const n=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const high=Buffer.from((n-1n).toString(16),'hex'),der=Buffer.concat([Buffer.from([0x30,38,2,1,1,2,33,0]),high]);
  expect(compactP256(der).subarray(32).toString('hex')).toBe('1'.padStart(64,'0'));
  for(const b of [Buffer.alloc(0),Buffer.from('3006020100020101','hex'),Buffer.from('300702020001020101','hex'),Buffer.concat([der,Buffer.from([0])])])expect(()=>compactP256(b)).toThrow();
});
function fixture(primaryOnly=false) {
  const p=key('primary'),b=key('backup');
  const approved:ApprovedAccount={walletId:wallet.id,owner:wallet.owner,address:wallet.address,accountWasmHash:ACCOUNT_V080_HASH,verifierAddress:verifier,verifierWasmHash:'a'.repeat(64),primaryRuleId:1,backupRuleId:2,primaryCredentialId:p.credential.id,backupCredentialId:b.credential.id,deploymentTransactionHash:'b'.repeat(64),recoveryTransactionHash:'c'.repeat(64)};
  const rule=(id:number,k:typeof p):ContextRule=>({id,name:'rule',context_type:{tag:'Default',values:undefined},signers:[{tag:'External',values:[verifier,credentialKeyData(k.credential)]}],signer_ids:[id],policies:[],policy_ids:[],valid_until:undefined});
  const rules=primaryOnly?[rule(0,p)]:[rule(1,p),rule(2,b)];let count=primaryOnly?1:2,omitIds=false,lookupLedger=100;
  const spec=new Client({contractId:wallet.address,networkPassphrase:PASSPHRASE,rpcUrl:'https://soroban-testnet.stellar.org'}).spec;
  const server={getNetwork:vi.fn(),getLedgerEntries:vi.fn(),simulateTransaction:vi.fn(async(tx:{toEnvelope:()=>xdr.TransactionEnvelope})=>{
    const fn=tx.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().invokeContract();
    const name=fn.functionName().toString();
    let retval=name==='get_signer_id'?xdr.ScVal.scvU32(rules.find(r=>spec.funcArgsToScVals('get_signer_id',{signer:r.signers[0]})[0].toXDR('base64')===fn.args()[0].toXDR('base64'))!.signer_ids[0]):name==='auth_digest'?xdr.ScVal.scvBytes(hash(fn.args()[0].toXDR())):name==='get_context_rules_count'?xdr.ScVal.scvU32(count):spec.nativeToScVal(rules.find(r=>r.id===fn.args()[0].u32()),xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({name:'ContextRule'})));
    if(omitIds && name==='get_context_rule')retval=xdr.ScVal.scvMap(retval.map()!.filter(e=>!['signer_ids','policy_ids'].includes(e.key().sym().toString())));
    return {_parsed:true,id:'1',latestLedger:name==='get_signer_id'?lookupLedger:100,events:[],minResourceFee:'0',transactionData:new SorobanDataBuilder(),result:{auth:[],retval}};
  })};
  const {backupRuleId:_rule,backupCredentialId:_credential,recoveryTransactionHash:_recovery,...base}=approved;
  const primary:PrimaryAccount={...base,primaryRuleId:0,mode:'primary-passkey'};
  const adapter=new PinnedAccountAdapter(server as unknown as AccountRpc,primaryOnly?async address=>address===wallet.address?primary:undefined:[approved],async()=>[p.credential,b.credential]);
  return {adapter,approved,rules,p,b,server,setCount:(v:number)=>{count=v;},hydrate:(ledger=100)=>{omitIds=true;lookupLedger=ledger;}};
}
describe('pinned on-chain rules and owned credentials',()=>{
  it('reads fresh code/rules and encodes only the exact primary payment',async()=>{
    const f=fixture(),policy=await f.adapter.current(wallet.address),w={...wallet,policy:policy.fingerprint};
    const a={id:'a',walletId:w.id,from:w.address,policy:w.policy,intent,prepared:{authXdr:entry(true).toXDR('base64'),expirationLedger:130,expiresAt:Date.now()+60000}} as Attempt;
    const description=await f.adapter.describe(w,a);expect(description.credentialIds).toEqual([f.p.credential.id]);
    expect(await f.adapter.encode(w,a,assertion(f.p,description.challenge).value)).toBeTruthy();
    await expect(f.adapter.encode(w,a,assertion(f.b,description.challenge).value)).rejects.toThrow('UNAUTHORIZED_TRANSFER_CREDENTIAL');
    expect(verifyCurrentContractCode).toHaveBeenCalledWith(f.server,verifier,'a'.repeat(64));
    f.rules[0].name='changed';await expect(f.adapter.describe(w,a)).rejects.toThrow('BINDING_CHANGED');
  });
  it('hydrates omitted IDs and invalidates reviewed authorization when a registry ID changes',async()=>{
    const f=fixture();f.hydrate();
    const policy=await f.adapter.current(wallet.address),w={...wallet,policy:policy.fingerprint};
    const a={id:'a',walletId:w.id,from:w.address,policy:w.policy,intent,prepared:{authXdr:entry(true).toXDR('base64'),expirationLedger:130,expiresAt:Date.now()+60000}} as Attempt;
    const plan=await f.adapter.describe(w,a);expect(plan.credentialIds).toEqual([f.p.credential.id]);
    expect(await f.adapter.encode(w,a,assertion(f.p,plan.challenge).value)).toBeTruthy();
    f.rules[0].signer_ids[0]=42;
    expect((await f.adapter.current(wallet.address)).fingerprint).not.toBe(policy.fingerprint);
    await expect(f.adapter.describe(w,a)).rejects.toThrow('ACCOUNT_POLICY_BINDING_CHANGED');
  });
  it('preserves existing fingerprints for rules that already include their IDs',async()=>{
    const f=fixture();
    const spec=new Client({contractId:wallet.address,networkPassphrase:PASSPHRASE,rpcUrl:'https://soroban-testnet.stellar.org'}).spec;
    const raw=f.rules.map(r=>spec.nativeToScVal(r,xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({name:'ContextRule'}))).toXDR('base64'));
    const legacy=createHash('sha256').update(JSON.stringify([PASSPHRASE,wallet.address,ACCOUNT_V080_HASH,verifier,'a'.repeat(64),...raw])).digest('hex');
    expect((await f.adapter.current(wallet.address)).fingerprint).toBe(legacy);
  });
  it('refuses registry lookups from another ledger, expired snapshots and missing registry IDs',async()=>{
    const mixed=fixture();mixed.hydrate(101);await expect(mixed.adapter.current(wallet.address)).rejects.toThrow('INCONSISTENT_POLICY_SNAPSHOT');
    const stale=fixture();stale.hydrate(99);await expect(stale.adapter.current(wallet.address)).rejects.toThrow('STALE_POLICY_READ');
    const missing=fixture();missing.hydrate();
    const original=missing.server.simulateTransaction.getMockImplementation()!;
    missing.server.simulateTransaction.mockImplementation(async tx=>{
      const result=await original(tx),fn=tx.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().invokeContract();
      if(fn.functionName().toString()==='get_signer_id')result.result.retval=xdr.ScVal.scvVoid();
      return result;
    });
    await expect(missing.adapter.current(wallet.address)).rejects.toThrow('SIGNER_ID_UNRESOLVED');
  });
  it('rejects multisig-as-recovery, extra policies/rules, signer mismatch and expiring rules',async()=>{
    for(const mutate of [(f:ReturnType<typeof fixture>)=>f.rules[0].signers.push(f.rules[1].signers[0]),(f:ReturnType<typeof fixture>)=>f.rules[0].policies.push(verifier),(f:ReturnType<typeof fixture>)=>f.setCount(3),(f:ReturnType<typeof fixture>)=>f.rules[0].signers[0]=f.rules[1].signers[0],(f:ReturnType<typeof fixture>)=>f.rules[1].valid_until=150]){const f=fixture();mutate(f);await expect(f.adapter.current(wallet.address)).rejects.toThrow();}
  });
  it('rejects unknown wallets and code verification failure',async()=>{
    const f=fixture();await expect(f.adapter.current(verifier)).rejects.toThrow('UNAPPROVED');
    vi.mocked(verifyCurrentContractCode).mockRejectedValueOnce(Error('code changed'));await expect(f.adapter.current(wallet.address)).rejects.toThrow('code changed');
  });
  it('refuses mixed ledger snapshots and RPC failure',async()=>{
    const f=fixture();
    // A single mixed snapshot is discarded and the whole read retried.
    vi.mocked(verifyCurrentContractCode).mockResolvedValueOnce({ledger:99,wasmHash:ACCOUNT_V080_HASH});
    await expect(f.adapter.current(wallet.address)).resolves.toMatchObject({recoveryReady:true});
    // A snapshot that never becomes consistent is refused.
    vi.mocked(verifyCurrentContractCode).mockResolvedValue({ledger:99,wasmHash:ACCOUNT_V080_HASH});
    await expect(f.adapter.current(wallet.address)).rejects.toThrow('INCONSISTENT_POLICY_SNAPSHOT');
    vi.mocked(verifyCurrentContractCode).mockResolvedValue({ledger:100,wasmHash:ACCOUNT_V080_HASH});
    f.server.simulateTransaction.mockRejectedValueOnce(Error('RPC down'));
    await expect(f.adapter.current(wallet.address)).rejects.toThrow('RPC down');
  });
  it('refuses a deployed helper using another digest scheme before offering a challenge',async()=>{
    const f=fixture(),policy=await f.adapter.current(wallet.address),w={...wallet,policy:policy.fingerprint};
    const a={id:'a',walletId:w.id,from:w.address,policy:w.policy,intent,prepared:{authXdr:entry(true).toXDR('base64'),expirationLedger:130,expiresAt:Date.now()+60000}} as Attempt;
    const original=f.server.simulateTransaction.getMockImplementation()!;
    f.server.simulateTransaction.mockImplementation(async tx=>{
      const result=await original(tx);
      if(tx.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().invokeContract().functionName().toString()==='auth_digest')result.result.retval=xdr.ScVal.scvBytes(Buffer.alloc(32));
      return result;
    });
    await expect(f.adapter.describe(w,a)).rejects.toThrow('ACCOUNT_DIGEST_MISMATCH');
  });
});

it('authorizes a primary-only wallet without inventing recovery readiness',async()=>{
  const f=fixture(true),policy=await f.adapter.current(wallet.address);
  expect(policy).toMatchObject({spendingReady:true,recoveryReady:false});
  const w={...wallet,policy:policy.fingerprint},a={id:'primary-attempt',walletId:w.id,from:w.address,policy:w.policy,intent,prepared:{authXdr:entry(true).toXDR('base64'),expirationLedger:130,expiresAt:Date.now()+60000}} as Attempt;
  const plan=await f.adapter.describe(w,a);
  expect(plan.credentialIds).toEqual([f.p.credential.id]);expect(plan.challenge).toBe(accountChallenge(entry(true),0));
  expect(await f.adapter.encode(w,a,assertion(f.p,plan.challenge).value)).toBeTruthy();
  await expect(f.adapter.encode(w,a,assertion(f.b,plan.challenge).value)).rejects.toThrow('UNAUTHORIZED_TRANSFER_CREDENTIAL');
  f.rules[0].signers[0]={tag:'External',values:[verifier,credentialKeyData(f.b.credential)]};
  await expect(f.adapter.current(wallet.address)).rejects.toThrow('ONCHAIN_SIGNER_KEY_MISMATCH');
});
it('never downgrades an approved two-rule wallet or accepts an extra rule in primary mode',async()=>{
  const legacy=fixture();legacy.setCount(1);await expect(legacy.adapter.current(wallet.address)).rejects.toThrow('UNEXPECTED_ACCOUNT_RULES');
  const primary=fixture(true);primary.setCount(2);await expect(primary.adapter.current(wallet.address)).rejects.toThrow('UNEXPECTED_ACCOUNT_RULES');
});
