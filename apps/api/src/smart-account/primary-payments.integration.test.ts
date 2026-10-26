import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../store.js';
import { runMigrations } from '../migrations.js';
import { deploymentFixture } from './test-support/deployment.js';
import { PrimaryWalletRegistry, paymentMonitorStart, monitorPrimaryWallets } from './primary-payments.js';

import {PostgresPaymentRepository} from '../payments/postgres-repository.js';
import {PaymentService} from '../payments/service.js';
import {mockChain,intent,transfer} from '../payments/test-fixtures.js';

const integration=process.env.RUN_DB_INTEGRATION==='1'?describe:describe.skip;
integration('automatic primary payment activation (synthetic database evidence)',()=>{
  const schema='primary_pay_'+randomUUID().replaceAll('-','');
  const pool=new Pool({... (process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST??'localhost',port:Number(process.env.DB_PORT??5432),database:process.env.DB_NAME??'cherrypay_wallet',user:process.env.DB_USER??'wallet',password:process.env.DB_PASSWORD}),options:'-c search_path='+schema,max:8});
  const registry=new PrimaryWalletRegistry(pool),policies={current:vi.fn(async()=>({fingerprint:'d'.repeat(64),recoveryReady:false,spendingReady:true}))};
  beforeAll(async()=>{await db.query(`CREATE SCHEMA "${schema}"`);await runMigrations(pool);},30000);
  afterAll(async()=>{await pool.end();await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);});
  async function deployed(){
    const f=deploymentFixture();
    await pool.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES($1,$2)',[f.owner,randomUUID()]);
    await pool.query('INSERT INTO wallet_credentials(id,account_id,public_key) VALUES($1,$2,$3)',[f.credential.id,f.owner,f.credential.public_key]);
    await pool.query(`INSERT INTO wallet_deployment_jobs(account_id,status,contract_address,descriptor,transaction_hash,confirmed_ledger,signer_rule_id,binding_verified_at)
      VALUES($1,'CONFIRMED',$2,$3,$4,300,0,NOW())`,[f.owner,f.descriptor.address,JSON.stringify(f.descriptor),randomBytes(32).toString('hex')]);
    return f;
  }
  it('activates each verified owner idempotently under concurrent requests',async()=>{
    const f=await deployed(),other=await deployed();
    expect(await registry.resolve(f.descriptor.address)).toMatchObject({mode:'primary-passkey',owner:f.owner,primaryRuleId:0});
    expect(await Promise.all(Array.from({length:5},()=>registry.ensure(f.owner,policies)))).toEqual(Array(5).fill(f.descriptor.address));
    const rows=(await pool.query('SELECT * FROM wallet_onchain_accounts WHERE owner=$1',[f.owner])).rows;
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({id:f.descriptor.address,policy:'d'.repeat(64),routes:['classic','contract']});
    expect((await pool.query('SELECT * FROM wallet_onchain_accounts WHERE owner=$1',[other.owner])).rows).toHaveLength(0);
    expect(await registry.ensure('unknown@example.test',policies)).toBeUndefined();
  });
  it('does not activate a changed credential or unverified binding',async()=>{
    const f=await deployed();await pool.query('UPDATE wallet_credentials SET public_key=$2 WHERE id=$1',[f.credential.id,deploymentFixture().credential.public_key]);
    await expect(registry.ensure(f.owner,policies)).rejects.toThrow('INVALID_PRIMARY_DEPLOYMENT_BINDING');
    const unverified=await deployed();await pool.query('UPDATE wallet_deployment_jobs SET binding_verified_at=NULL WHERE account_id=$1',[unverified.owner]);
    expect(await registry.ensure(unverified.owner,policies)).toBeUndefined();
  });
  it('preserves pinned policies and refuses foreign or operator-provisioned bindings',async()=>{
    const f=await deployed();await registry.ensure(f.owner,policies);
    await expect(registry.ensure(f.owner,{current:async()=>({fingerprint:'e'.repeat(64),recoveryReady:false,spendingReady:true})})).rejects.toThrow('EXISTING_WALLET_BINDING_CONFLICT');
    const g=await deployed();await pool.query(`INSERT INTO wallet_onchain_accounts(id,owner,network,address,policy,created_at) VALUES('operator-wallet',$1,'TESTNET',$2,$3,$4)`,[g.owner,g.descriptor.address,'d'.repeat(64),Date.now()]);
    await expect(registry.ensure(g.owner,policies)).rejects.toThrow('EXISTING_WALLET_BINDING_CONFLICT');
    expect((await pool.query('SELECT policy FROM wallet_onchain_accounts WHERE id=$1',[f.descriptor.address])).rows[0].policy).toBe('d'.repeat(64));
  });
  it('does not turn recovery-only evidence or failed policy reads into spending permission',async()=>{
    const f=await deployed();
    await expect(registry.ensure(f.owner,{current:async()=>({fingerprint:'d'.repeat(64),recoveryReady:true,spendingReady:false})})).rejects.toThrow('PRIMARY_POLICY_UNAVAILABLE');
    await expect(registry.ensure(f.owner,{current:async()=>{throw Error('RPC unavailable');}})).rejects.toThrow('RPC unavailable');
    expect((await pool.query('SELECT * FROM wallet_onchain_accounts WHERE owner=$1',[f.owner])).rows).toHaveLength(0);
  });
  it('keeps the deployment scan boundary and cursor across restarts',async()=>{
    const latest=vi.fn(async()=>900);
    expect(await paymentMonitorStart(pool,latest)).toBe(300);expect(latest).not.toHaveBeenCalled();
    await pool.query("UPDATE wallet_monitor_cursors SET cursor='durable-page' WHERE id='TESTNET:native_xlm_sac:monitor'");
    expect(await paymentMonitorStart(pool,async()=>1000)).toBe(300);
    expect((await pool.query("SELECT cursor FROM wallet_monitor_cursors WHERE id='TESTNET:native_xlm_sac:monitor'")).rows[0].cursor).toBe('durable-page');
  });
  it('indexes external receipts with independent durable wallet cursors and preserves failed pages',async()=>{
    const f=await deployed();await registry.ensure(f.owner,policies);const chain=mockChain(),event=transfer({to:f.descriptor.address});
    vi.mocked(chain.events).mockImplementation(async(_cursor,_start,address)=>({events:address===f.descriptor.address?[event]:[],cursor:'wallet-page-1'}));
    await monitorPrimaryWallets(pool,chain);
    const repo=new PostgresPaymentRepository(pool,'TESTNET:native_xlm_sac:wallet:'+f.descriptor.address);
    expect(await repo.cursor()).toBe('wallet-page-1');expect((await repo.history(f.descriptor.address))[0].event).toEqual(event);
    expect(chain.events).toHaveBeenCalledWith(undefined,300,f.descriptor.address);
    expect((await pool.query("SELECT cursor FROM wallet_monitor_cursors WHERE id='TESTNET:native_xlm_sac:monitor'")).rows[0].cursor).toBe('durable-page');
    vi.mocked(chain.events).mockImplementation(async(_cursor,_start,address)=>{if(address===f.descriptor.address)throw Error('RPC retention or receipt failure');return {events:[],cursor:'wallet-page-2'};});
    await expect(monitorPrimaryWallets(pool,chain)).rejects.toThrow('WALLET_MONITOR_RETRY_REQUIRED');expect(await repo.cursor()).toBe('wallet-page-1');
    vi.mocked(chain.events).mockResolvedValue({events:[],cursor:'wallet-page-3'});await monitorPrimaryWallets(pool,chain);
    expect(chain.events).toHaveBeenCalledWith('wallet-page-1',300,f.descriptor.address);
  });
  it('serializes missing-key reset against late and concurrent creation without deleting attempts',async()=>{
    const f=await deployed();await registry.ensure(f.owner,policies);const repo=new PostgresPaymentRepository(pool),w=await repo.wallet(f.descriptor.address,f.owner);
    const chain=mockChain(),service=new PaymentService(repo,chain,policies,300),key='reset-missing-'+randomUUID();
    expect(await service.reset(f.owner,w.id,key)).toEqual({reset:true,outcome:'not_created'});
    await expect(repo.create(w,intent,key)).rejects.toThrow('PAYMENT_PREPARATION_RESET');
    for(let i=0;i<3;i++){
      const race='reset-race-'+randomUUID();const results=await Promise.allSettled([repo.create(w,intent,race),service.reset(f.owner,w.id,race)]);
      expect(results[1].status).toBe('fulfilled');const attempt=await repo.byKey(w.id,race);
      if(attempt)expect(attempt).toMatchObject({status:'rejected',failureCode:'USER_CANCELLED'});
      else await expect(repo.create(w,intent,race)).rejects.toThrow('PAYMENT_PREPARATION_RESET');
    }
    expect((await pool.query('SELECT attempt_id FROM wallet_relayer_locks')).rows.every(row=>row.attempt_id===null)).toBe(true);
  });

});
