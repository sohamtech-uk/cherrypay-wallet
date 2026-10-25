import { Keypair } from '@stellar/stellar-sdk';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { getConfig } from '../config.js';
import { db, initializeStore, getCredentials, revokeSession } from '../store.js';
import { testPasskey } from '../test-passkey.js';
import { AutomaticDeploymentService } from './automatic-deployment.js';
import { PostgresDeploymentStore } from './automatic-deployment-store.js';
import { credentialKeyData } from './pinned-adapter.js';
import type { DeploymentChain, DeploymentDescriptor, PreparedDeployment } from './automatic-deployment-chain.js';

const integration=process.env.RUN_DB_INTEGRATION==='1'?describe:describe.skip;
integration('verified registration to immutable PostgreSQL deployment binding',()=>{
  beforeAll(async()=>{await initializeStore();},30000);
  it('automatically queues the first verified key and never replaces it when a backup is enrolled',async()=>{
    const deployer=Keypair.random();
    const store=new PostgresDeploymentStore(deployer.publicKey());
    const chain:DeploymentChain={publicKey:deployer.publicKey(),prepare:vi.fn(),submit:vi.fn(),outcome:vi.fn()};
    const service=new AutomaticDeploymentService(store,chain);
    // Only the network is synthetic. The actual WebAuthn verification, sessions,
    // HTTP handler, descriptor derivation and SQL transactions execute below.
    const start=vi.spyOn(service,'start').mockReturnValue(async()=>{});
    const app=await buildApp({config:getConfig({WALLET_ORIGIN:'https://wallet.example'}),logger:false,deployments:service});
    const tokens:string[]=[];
    const post=(path:string,payload:Record<string,unknown>,token?:string)=>app.inject({method:'POST',url:'/api/v1/'+path,headers:{origin:'https://wallet.example',...(token?{authorization:'Bearer '+token}:{})},payload});
    try {
      const primary=testPasskey(),backup=testPasskey();
      const begin=(await post('passkeys/registration/options',{})).json();
      expect(await store.get(begin.accountID)).toBeUndefined();
      const result=await post('passkeys/registration/verify',{accountID:begin.accountID,requestID:begin.requestID,response:primary.registration(begin.options.challenge)});
      expect(result.statusCode).toBe(200);const first=result.json();tokens.push(first.token);
      const initial=await store.get(first.accountID);
      expect(initial).toMatchObject({status:'PENDING',bindingVerified:false,descriptor:{owner:first.accountID,credentialId:primary.id,deployerPublicKey:deployer.publicKey()}});
      const stored=(await getCredentials(first.accountID)).find(c=>c.id===primary.id)!;
      expect(initial!.descriptor!.keyDataHex).toBe(credentialKeyData(stored).toString('hex'));
      expect(initial!.prepared).toBeUndefined();
      const repeated=await post('smart-account/deployment',{},first.token);
      expect(repeated.statusCode).toBe(202);expect(repeated.json()).toMatchObject({status:'PENDING',address:null,onChainSignerBound:false});
      expect((await store.get(first.accountID))!.descriptor).toEqual(initial!.descriptor);
      expect((await post('smart-account/deployment',{credentialId:backup.id},first.token)).statusCode).toBe(400);
      const next=(await post('passkeys/registration/options',{accountID:first.accountID},first.token)).json();
      const added=await post('passkeys/registration/verify',{accountID:first.accountID,requestID:next.requestID,response:backup.registration(next.options.challenge)},first.token);
      expect(added.statusCode).toBe(200);tokens.push(added.json().token);
      expect(added.json()).toMatchObject({credentialCount:2,recoveryReady:false});
      expect((await store.get(first.accountID))!.descriptor).toEqual(initial!.descriptor);
      vi.mocked(chain.prepare).mockImplementation(async(d:DeploymentDescriptor)=>{
        expect(d).toEqual(initial!.descriptor);
        return {signedXdr:'synthetic-registration-deployment',transactionHash:'d'.repeat(64),expiresAt:Date.now()+60000};
      });
      vi.mocked(chain.outcome).mockResolvedValue({status:'NOT_FOUND'});
      vi.mocked(chain.submit).mockImplementation(async(d:DeploymentDescriptor,p:PreparedDeployment)=>{
        expect((await store.get(d.owner))!.prepared).toEqual(p);
      });
      await service.tick();
      expect(chain.submit).toHaveBeenCalledTimes(1);
      expect((await store.get(first.accountID))!.status).toBe('SUBMITTED');
      // Simulated confirmation is not live Stellar evidence.
      await db.query('UPDATE wallet_deployment_jobs SET next_attempt_at=NOW() WHERE account_id=$1',[first.accountID]);
      vi.mocked(chain.outcome).mockResolvedValue({status:'CONFIRMED',ledger:350,signerRuleId:0});
      await service.tick();
      const status=await app.inject({url:'/api/v1/smart-account/deployment',headers:{authorization:'Bearer '+added.json().token}});
      expect(status.json()).toMatchObject({status:'CONFIRMED',address:initial!.descriptor!.address,onChainSignerBound:true,primaryCredentialId:primary.id,recoveryReady:false,spendingEnabled:false});
      expect((await db.query('SELECT id FROM wallet_onchain_accounts WHERE owner=$1',[first.accountID])).rows).toEqual([]);
      expect((await app.inject({url:'/api/v1/wallets',headers:{authorization:'Bearer '+added.json().token}})).statusCode).toBe(503);
      await revokeSession(added.json().token);
      expect((await app.inject({url:'/api/v1/smart-account/deployment',headers:{authorization:'Bearer '+added.json().token}})).statusCode).toBe(401);
    } finally {await app.close();start.mockRestore();await Promise.all(tokens.map(revokeSession));}
  });
  it('never creates a deployment plan for a rejected registration or unowned account ID',async()=>{
    const deployer=Keypair.random(),store=new PostgresDeploymentStore(deployer.publicKey());
    const chain:DeploymentChain={publicKey:deployer.publicKey(),prepare:vi.fn(),submit:vi.fn(),outcome:vi.fn()};
    const service=new AutomaticDeploymentService(store,chain),start=vi.spyOn(service,'start').mockReturnValue(async()=>{});
    const app=await buildApp({config:getConfig({WALLET_ORIGIN:'https://wallet.example'}),logger:false,deployments:service});
    const post=(path:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:'/api/v1/'+path,headers:{origin:'https://wallet.example'},payload});
    try {
      const key=testPasskey(),begin=(await post('passkeys/registration/options',{})).json();
      const bad=await post('passkeys/registration/verify',{accountID:begin.accountID,requestID:begin.requestID,response:key.registration(begin.options.challenge,'https://wrong.example')});
      expect(bad.statusCode).toBe(400);expect(await store.get(begin.accountID)).toBeUndefined();
      expect((await post('smart-account/deployment',{})).statusCode).toBe(401);
      expect(await store.claim()).toBeUndefined();expect(chain.prepare).not.toHaveBeenCalled();
    } finally {await app.close();start.mockRestore();}
  });
});
