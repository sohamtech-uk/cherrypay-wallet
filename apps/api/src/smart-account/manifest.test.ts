import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { configuredPayments, parsePaymentManifest, readPaymentManifest } from './manifest.js';
import { createPinnedPaymentRuntime } from './runtime.js';
import { manifestFixture } from './test-support/manifest.js';
vi.mock('./runtime.js',()=>({createPinnedPaymentRuntime:vi.fn(async()=>({configured:true}))}));
const directories: string[]=[];
afterEach(async()=>{vi.clearAllMocks();await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function file(contents:string) { const directory=await mkdtemp(join(tmpdir(),'wallet-manifest-'));directories.push(directory);const path=join(directory,'manifest.json');await writeFile(path,contents);return path; }
it('accepts only a bounded, immutable Testnet manifest with canonical owned-account identifiers',()=>{
  const fixture=manifestFixture(), parsed=parsePaymentManifest(fixture);
  expect(Object.isFrozen(parsed.accounts[0])).toBe(true);
  expect(parsed).toEqual(fixture);
  for(const changed of [null,{}, {...fixture,network:'PUBLIC'},{...fixture,version:2},{...fixture,startLedger:0},{...fixture,startLedger:1.5},{...fixture,relayerPublicKey:'secret'}, {...fixture,accounts:[]},{...fixture,accounts:Array(101).fill(fixture.accounts[0])},{...fixture,relayerSecret:'do-not-allow-secrets'}])expect(()=>parsePaymentManifest(changed)).toThrow();
});
it('rejects unknown fields, unsafe code, duplicate identities, incomplete evidence and invalid rule or credential bindings',()=>{
  const m=manifestFixture(), a=m.accounts[0];
  for(const changes of [{owner:'not-a-uuid'},{walletId:'path/escape'},{address:'G-invalid'},{accountWasmHash:'1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a'},{verifierWasmHash:'a'}, {primaryRuleId:0x100000000},{backupRuleId:a.primaryRuleId},{backupCredentialId:a.primaryCredentialId},{primaryCredentialId:'AA=='},{recoveryTransactionHash:a.deploymentTransactionHash},{deploymentTransactionHash:''},{secretKey:'private'}])expect(()=>parsePaymentManifest({...m,accounts:[{...a,...changes}]})).toThrow();
  expect(()=>parsePaymentManifest({...m,accounts:[a,{...a,walletId:'different'}]})).toThrow('DUPLICATE');
});
it('bounds file reads and never includes invalid JSON contents in errors',async()=>{
  await expect(readPaymentManifest(await file('secret-value-is-not-json'))).rejects.toThrow('INVALID_MANIFEST_JSON');
  await expect(readPaymentManifest(await file(' '.repeat(1024*1024+1)))).rejects.toThrow('MANIFEST_TOO_LARGE');
  expect(await readPaymentManifest(await file(JSON.stringify(manifestFixture())))).toEqual(manifestFixture());
});
it('defaults off, rejects partial enablement and binds the secret to the approved relayer public key',async()=>{
  expect(await configuredPayments({})).toEqual({});
  expect(await configuredPayments({WALLET_PAYMENTS_ENABLED:'false',WALLET_PAYMENT_MANIFEST:'missing'})).toEqual({});
  await expect(configuredPayments({WALLET_PAYMENTS_ENABLED:'yes'})).rejects.toThrow('INVALID_PAYMENT_ENABLE_FLAG');
  await expect(configuredPayments({WALLET_PAYMENTS_ENABLED:'true'})).rejects.toThrow('PAYMENT_CONFIGURATION_REQUIRED');
  const env={WALLET_PAYMENTS_ENABLED:'true',WALLET_PAYMENT_MANIFEST:await file(JSON.stringify(manifestFixture())),STELLAR_RELAYER_SECRET:Keypair.random().secret()};
  await expect(configuredPayments(env)).rejects.toThrow('RELAYER_IDENTITY_MISMATCH');
  expect(createPinnedPaymentRuntime).not.toHaveBeenCalled();
  env.STELLAR_RELAYER_SECRET=Keypair.fromRawEd25519Seed(Buffer.alloc(32,4)).secret();
  await configuredPayments(env);
  expect(createPinnedPaymentRuntime).toHaveBeenCalledWith({accounts:manifestFixture().accounts,startLedger:100,relayerSecret:env.STELLAR_RELAYER_SECRET});
});
