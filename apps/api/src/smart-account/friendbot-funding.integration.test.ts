import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {Keypair} from '@stellar/stellar-sdk';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {db} from '../store.js';
import {runMigrations} from '../migrations.js';
import type {Outcome,TransferEvent} from '../payments/model.js';
import {deploymentFixture} from './test-support/deployment.js';
import {FriendbotFundingService,FRIENDBOT_ALLOCATION_STROOPS} from './friendbot-funding.js';
const integration=process.env.RUN_DB_INTEGRATION==='1'?describe:describe.skip;
integration('durable direct Friendbot grants (synthetic provider and chain)',()=>{
 const schema='friendbot_'+randomUUID().replaceAll('-','');
 const pool=new Pool({...process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST??'localhost',port:Number(process.env.DB_PORT??5432),database:process.env.DB_NAME??'cherrypay_wallet',user:process.env.DB_USER??'wallet',password:process.env.DB_PASSWORD},options:'-c search_path='+schema,max:8});
 beforeAll(async()=>{await db.query(`CREATE SCHEMA "${schema}"`);await runMigrations(pool);},30000);
 afterAll(async()=>{await pool.end();await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);});
 async function fixture(){
  // Isolate each test's worker queue, while keeping all migration checks active.
  await pool.query('DELETE FROM wallet_friendbot_funding');
  const f=deploymentFixture(),hash=randomUUID().replaceAll('-','').repeat(2);
  await pool.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES($1,$2)',[f.owner,randomUUID()]);
  await pool.query(`INSERT INTO wallet_deployment_jobs(account_id,status,contract_address,descriptor,confirmed_ledger,signer_rule_id,binding_verified_at,transaction_hash)
    VALUES($1,'CONFIRMED',$2,$3,200,0,NOW(),$4)`,[f.owner,f.descriptor.address,JSON.stringify(f.descriptor),randomUUID().replaceAll('-','').repeat(2)]);
  const chain={verify:vi.fn(async()=>{}),latestLedger:vi.fn(async()=>200),request:vi.fn(async(_address:string)=>hash),outcome:vi.fn(async():Promise<Outcome>=>({status:'NOT_FOUND'}))};
  const service=new FriendbotFundingService(chain,pool);
  const event={from:Keypair.random().publicKey(),to:f.descriptor.address,amountStroops:FRIENDBOT_ALLOCATION_STROOPS,ledger:201,transactionHash:hash} as TransferEvent;
  return {...f,chain,service,hash,event};
 }
 it('never funds on login, verifies the binding before sending, and deduplicates concurrent clicks/workers',async()=>{
  const f=await fixture();await f.service.tick();expect(f.chain.request).not.toHaveBeenCalled();
  await expect(f.service.queue('missing-owner')).rejects.toThrow('VERIFIED_UNFUNDED_C_WALLET_REQUIRED');
  await Promise.all(Array.from({length:5},()=>f.service.queue(f.owner)));
  await Promise.all([f.service.tick(),new FriendbotFundingService(f.chain,pool).tick()]);
  expect(f.chain.verify).toHaveBeenCalledWith(f.descriptor,200);
  expect(f.chain.request).toHaveBeenCalledTimes(1);
  expect(await f.service.status(f.owner)).toMatchObject({status:'SUBMITTED',amountStroops:FRIENDBOT_ALLOCATION_STROOPS});
 });
 it('checkpoints before HTTP and never repeats an unknown request after restart',async()=>{
  const f=await fixture();await f.service.queue(f.owner);
  f.chain.request.mockImplementationOnce(async()=>{
   const r=(await pool.query('SELECT status,start_ledger,request_started_at FROM wallet_friendbot_funding WHERE account_id=$1',[f.owner])).rows[0];
   expect(r.status).toBe('SUBMITTED');expect(Number(r.start_ledger)).toBe(200);expect(r.request_started_at).toBeTruthy();
   throw Error('Lost HTTP response after possible transfer');
  });
  await f.service.tick();await new FriendbotFundingService(f.chain,pool).tick();await f.service.queue(f.owner);
  expect(f.chain.request).toHaveBeenCalledTimes(1);
  expect(await f.service.status(f.owner)).toMatchObject({status:'REVIEW_REQUIRED'});
 });
 it('reconciles a saved hash after restart and rejects mismatched amounts before confirming',async()=>{
  const f=await fixture();await f.service.queue(f.owner);
  f.chain.outcome.mockRejectedValueOnce(Error('RPC timeout'));
  await f.service.tick();expect(await f.service.status(f.owner)).toMatchObject({status:'SUBMITTED',transactionHash:f.hash});
  const restarted=new FriendbotFundingService(f.chain,pool);
  f.chain.outcome.mockResolvedValue({status:'SUCCESS',transactionHash:f.hash,events:[{...f.event,amountStroops:'1'}]});
  await restarted.tick();expect(await restarted.status(f.owner)).toMatchObject({status:'SUBMITTED'});
  f.chain.outcome.mockResolvedValue({status:'SUCCESS',transactionHash:f.hash,events:[f.event]});
  await restarted.tick();expect(await restarted.status(f.owner)).toMatchObject({status:'FUNDED',ledger:201,transactionHash:f.hash});
  await restarted.queue(f.owner);await restarted.tick();expect(f.chain.request).toHaveBeenCalledTimes(1);
 });
 it('keeps pre-request binding/RPC failures pending without calling Friendbot',async()=>{
  const f=await fixture();await f.service.queue(f.owner);f.chain.verify.mockRejectedValueOnce(Error('Binding changed'));
  await f.service.tick();expect(await f.service.status(f.owner)).toMatchObject({status:'PENDING'});expect(f.chain.request).not.toHaveBeenCalled();
 });
 it('does not send when the persisted HTTP checkpoint acknowledgement is lost',async()=>{
  const f=await fixture();await f.service.queue(f.owner);
  const interruptedPool={connect:async()=>{
   const client=await pool.connect(),query=client.query.bind(client);
   return {release:client.release.bind(client),query:async(sql:string,values:unknown[])=>{
    const result=await query(sql,values);
    if(sql.includes("SET status='SUBMITTED',request_started_at"))throw Error('Commit acknowledgement lost');
    return result;
   }};
  }} as unknown as Pool;
  await new FriendbotFundingService(f.chain,interruptedPool).tick();
  await f.service.tick();expect(f.chain.request).not.toHaveBeenCalled();
  expect(await f.service.status(f.owner)).toMatchObject({status:'REVIEW_REQUIRED'});
 });
 it('preserves old treasury records and refuses a second grant for their owner/address',async()=>{
  const f=await fixture();
  await pool.query('INSERT INTO wallet_contract_funding(account_id,address,source) VALUES($1,$2,$3)',[f.owner,f.descriptor.address,Keypair.random().publicKey()]);
  await expect(f.service.queue(f.owner)).rejects.toThrow('VERIFIED_UNFUNDED_C_WALLET_REQUIRED');
  expect(await f.service.status(f.owner)).toMatchObject({status:'REVIEW_REQUIRED',amountStroops:'1000000000000'});
  await f.service.tick();expect(f.chain.request).not.toHaveBeenCalled();
 });
});
