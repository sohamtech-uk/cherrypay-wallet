import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../store.js';
import { runMigrations } from '../migrations.js';
import { PostgresDeploymentStore } from './automatic-deployment-store.js';
import { deploymentFixture } from './test-support/deployment.js';
import { publicDeployment } from './automatic-deployment.js';

const integration = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
integration('automatic deployment PostgreSQL invariants (no chain submission)', () => {
  const schema = 'auto_deploy_' + randomUUID().replaceAll('-','');
  const pool = new Pool({
    ...(process.env.DATABASE_URL ? {connectionString:process.env.DATABASE_URL} : {
      host:process.env.DB_HOST??'localhost',port:Number(process.env.DB_PORT??5432),database:process.env.DB_NAME??'cherrypay_wallet',
      user:process.env.DB_USER??'wallet',password:process.env.DB_PASSWORD,
    }), options:'-c search_path='+schema,max:8,
  });
  beforeAll(async () => { await db.query(`CREATE SCHEMA "${schema}"`); await runMigrations(pool); await runMigrations(pool); },30000);
  afterAll(async () => { await pool.end(); await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); });
  async function owner(withCredential = true) {
    const f=deploymentFixture();
    await pool.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES($1,$2)',[f.owner,randomUUID()]);
    if(withCredential)await credential(f.owner,f.credential);
    return f;
  }
  async function credential(accountID:string,c:{id:string;public_key:string}) {
    await pool.query('INSERT INTO wallet_credentials(id,account_id,public_key,counter) VALUES($1,$2,$3,0)',[c.id,accountID,c.public_key]);
  }
  it('applies the additive deployment schema once without changing prior migrations',async()=>{
    const result=await pool.query("SELECT name,count(*)::int AS count FROM wallet_schema_migrations WHERE name='010_automatic_contract_deployment.sql' GROUP BY name");
    expect(result.rows).toEqual([{name:'010_automatic_contract_deployment.sql',count:1}]);
  });
  it('requires a verified stored credential and makes concurrent queue requests idempotent',async()=>{
    const f=await owner(false),store=new PostgresDeploymentStore(f.deployer.publicKey(),pool);
    expect(await store.queue(f.owner)).toMatchObject({status:'AWAITING_PASSKEY',descriptor:undefined});
    expect(await store.claim()).toBeUndefined();
    await credential(f.owner,f.credential);
    const jobs=await Promise.all(Array.from({length:5},()=>store.queue(f.owner)));
    expect(new Set(jobs.map(j=>j.descriptor!.address)).size).toBe(1);
    expect(jobs[0]).toMatchObject({status:'PENDING',bindingVerified:false,descriptor:f.descriptor});
    expect((await pool.query('SELECT count(*)::int AS count FROM wallet_deployment_jobs WHERE account_id=$1',[f.owner])).rows[0].count).toBe(1);
    const backup=deploymentFixture();await credential(f.owner,backup.credential);
    expect((await store.queue(f.owner)).descriptor).toEqual(f.descriptor);
  });
  it('separates users, pins the deployment fee source and refuses existing activated wallets',async()=>{
    const a=await owner(),b=await owner(),store=new PostgresDeploymentStore(a.deployer.publicKey(),pool);
    const first=await store.queue(a.owner),second=await store.queue(b.owner);
    expect(first.descriptor!.address).not.toBe(second.descriptor!.address);
    expect(second.descriptor).toMatchObject({owner:b.owner,credentialId:b.credential.id});
    await expect(new PostgresDeploymentStore(b.deployer.publicKey(),pool).queue(a.owner)).rejects.toThrow('DEPLOYMENT_CREDENTIAL_BINDING_CHANGED');
    const existing=await owner();
    await pool.query("INSERT INTO wallet_onchain_accounts(id,owner,network,address,policy,created_at) VALUES($1,$2,'TESTNET',$3,$4,$5)",[randomUUID(),existing.owner,existing.descriptor.address,'a'.repeat(64),Date.now()]);
    await expect(store.queue(existing.owner)).rejects.toThrow('EXISTING_WALLET_REQUIRES_REVIEW');
  });
  it('fences stale workers and keeps one sponsor reserved until a verified terminal result',async()=>{
    const a=await owner(),b=await owner(),store=new PostgresDeploymentStore(a.deployer.publicKey(),pool);
    await store.queue(a.owner);await store.queue(b.owner);
    const first=(await store.claim())!;expect(first.owner).toBe(a.owner);
    expect(await new PostgresDeploymentStore(a.deployer.publicKey(),pool).claim()).toBeUndefined();
    await pool.query("UPDATE wallet_deployment_jobs SET lease_until=NOW()-INTERVAL '1 second' WHERE account_id=$1",[a.owner]);
    const replacement=(await store.claim())!;
    expect(replacement.leaseToken).not.toBe(first.leaseToken);
    await expect(store.assertBinding(first)).rejects.toThrow('DEPLOYMENT_LEASE_OR_CREDENTIAL_CHANGED');
    const p={signedXdr:'synthetic-durable-envelope',transactionHash:'a'.repeat(64),expiresAt:Date.now()+60000};
    await expect(store.checkpoint(first,p)).rejects.toThrow('DEPLOYMENT_CHECKPOINT_NOT_COMMITTED');
    const saved=await store.checkpoint(replacement,p);
    await expect(store.checkpoint(saved,{...p,signedXdr:'replacement'})).rejects.toThrow('DEPLOYMENT_CHECKPOINT_NOT_COMMITTED');
    await store.retry(saved,'DEPLOYMENT_AWAITING_CONFIRMATION');
    expect((await pool.query('SELECT account_id FROM wallet_deployment_sponsors WHERE public_key=$1',[a.deployer.publicKey()])).rows[0].account_id).toBe(a.owner);
    expect(await store.claim()).toBeUndefined(); // Backoff must not permit another job's sequence.
    await pool.query('UPDATE wallet_deployment_jobs SET next_attempt_at=NOW() WHERE account_id=$1',[a.owner]);
    const reopened=new PostgresDeploymentStore(a.deployer.publicKey(),pool), resumed=(await reopened.claim())!;
    expect(resumed.prepared).toEqual(p);expect(resumed.owner).toBe(a.owner);
    // Synthetic evidence exercises SQL boundaries, not live contract verification.
    await reopened.settle(resumed,{status:'CONFIRMED',ledger:300,signerRuleId:0});
    expect(publicDeployment(await reopened.get(a.owner))).toMatchObject({status:'CONFIRMED',address:a.descriptor.address,onChainSignerBound:true,recoveryReady:false,spendingEnabled:false});
    expect((await reopened.claim())!.owner).toBe(b.owner);
    expect((await pool.query('SELECT id FROM wallet_onchain_accounts WHERE owner=$1',[a.owner])).rows).toEqual([]);
  });
  it('refuses a credential moved to another owner or changed after queueing',async()=>{
    const f=await owner(),other=await owner(false),store=new PostgresDeploymentStore(f.deployer.publicKey(),pool);
    await store.queue(f.owner);const claimed=(await store.claim())!;
    await store.assertBinding(claimed);
    await pool.query('UPDATE wallet_credentials SET account_id=$2 WHERE id=$1',[f.credential.id,other.owner]);
    await expect(store.assertBinding(claimed)).rejects.toThrow('DEPLOYMENT_LEASE_OR_CREDENTIAL_CHANGED');
    await expect(store.queue(f.owner)).rejects.toThrow('DEPLOYMENT_CREDENTIAL_BINDING_CHANGED');
  });
  it('enforces a bounded deployment pilot without preventing idempotent recovery',async()=>{
    const a=await owner(),b=await owner(),store=new PostgresDeploymentStore(a.deployer.publicKey(),pool,1);
    const first=await store.queue(a.owner);
    await expect(store.queue(b.owner)).rejects.toThrow('DEPLOYMENT_PILOT_LIMIT_REACHED');
    expect((await store.queue(a.owner)).descriptor).toEqual(first.descriptor);
    expect(await store.get(b.owner)).toBeUndefined();
  });
});
