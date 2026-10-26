import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {Keypair} from '@stellar/stellar-sdk';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {db} from '../store.js';
import {runMigrations} from '../migrations.js';
import type {Outcome,TransferEvent} from '../payments/model.js';
import {deploymentFixture} from './test-support/deployment.js';
import {ContractFundingService,TESTNET_ALLOCATION_STROOPS} from './contract-funding.js';
const integration=process.env.RUN_DB_INTEGRATION==='1'?describe:describe.skip;
integration('durable user-requested C-wallet funding (synthetic chain evidence)',()=>{
 const schema='funding_'+randomUUID().replaceAll('-','');
 const pool=new Pool({...process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST??'localhost',port:Number(process.env.DB_PORT??5432),database:process.env.DB_NAME??'cherrypay_wallet',user:process.env.DB_USER??'wallet',password:process.env.DB_PASSWORD},options:'-c search_path='+schema,max:8});
 beforeAll(async()=>{await db.query(`CREATE SCHEMA "${schema}"`);await runMigrations(pool);},30000);
 afterAll(async()=>{await pool.end();await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);});
 async function fixture(){
  const f=deploymentFixture(),source=Keypair.random().publicKey();
  await pool.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES($1,$2)',[f.owner,randomUUID()]);
  await pool.query(`INSERT INTO wallet_deployment_jobs(account_id,status,contract_address,descriptor,confirmed_ledger,signer_rule_id,binding_verified_at)
    VALUES($1,'CONFIRMED',$2,$3,200,0,NOW())`,[f.owner,f.descriptor.address,JSON.stringify(f.descriptor)]);
  const p={signedXdr:'synthetic-checkpoint',transactionHash:randomUUID().replaceAll('-','').repeat(2),expiresAt:Date.now()+60000};
  const chain={source,verify:vi.fn(async()=>{}),prepare:vi.fn(async()=>p),submit:vi.fn(async(_prepared:typeof p)=>{}),outcome:vi.fn(async():Promise<Outcome>=>({status:'NOT_FOUND'}))};
  const service=new ContractFundingService(chain,pool);
  const event={from:source,to:f.descriptor.address,amountStroops:TESTNET_ALLOCATION_STROOPS,ledger:201} as TransferEvent;
  return {...f,chain,service,p,event};
 }
 it('does not fund on login or deployment, rejects unknown owners and deduplicates concurrent clicks',async()=>{
  const f=await fixture();await f.service.tick();expect(f.chain.prepare).not.toHaveBeenCalled();
  await expect(f.service.queue('missing-owner')).rejects.toThrow('VERIFIED_C_WALLET_REQUIRED');
  await Promise.all(Array.from({length:5},()=>f.service.queue(f.owner)));
  expect((await pool.query('SELECT count(*)::int AS count FROM wallet_contract_funding WHERE account_id=$1',[f.owner])).rows[0].count).toBe(1);
  expect(await f.service.status(f.owner)).toMatchObject({status:'PENDING',amountStroops:TESTNET_ALLOCATION_STROOPS});
 });
 it('checkpoints before a lost broadcast response, resumes identical bytes and confirms only matching receipts',async()=>{
  const f=await fixture();await f.service.queue(f.owner);
  f.chain.submit.mockImplementationOnce(async()=>{
   expect((await pool.query('SELECT signed_xdr FROM wallet_contract_funding WHERE account_id=$1',[f.owner])).rows[0].signed_xdr).toBe(f.p.signedXdr);
   throw Error('Lost RPC response');
  });
  await f.service.tick();expect(await f.service.status(f.owner)).toMatchObject({status:'SUBMITTED'});
  const restarted=new ContractFundingService(f.chain,pool);await restarted.tick();
  expect(f.chain.prepare).toHaveBeenCalledTimes(1);expect(f.chain.submit.mock.calls.map(([p])=>p)).toEqual([f.p,f.p]);
  f.chain.outcome.mockResolvedValue({status:'SUCCESS',transactionHash:f.p.transactionHash,events:[{...f.event,amountStroops:'1'}]});
  await restarted.tick();expect(await restarted.status(f.owner)).toMatchObject({status:'SUBMITTED'});
  f.chain.outcome.mockResolvedValue({status:'SUCCESS',transactionHash:f.p.transactionHash,events:[f.event]});
  await restarted.tick();expect(await restarted.status(f.owner)).toMatchObject({status:'FUNDED',ledger:201,transactionHash:f.p.transactionHash});
  await restarted.queue(f.owner);await restarted.tick();expect(f.chain.prepare).toHaveBeenCalledTimes(1);
 });
 it('serializes workers and retains a source reservation after an expired uncertain transaction',async()=>{
  const f=await fixture();await f.service.queue(f.owner);
  f.p.expiresAt=Date.now()-1;
  await Promise.all([f.service.tick(),new ContractFundingService(f.chain,pool).tick()]);
  expect(f.chain.prepare).toHaveBeenCalledTimes(1);expect(f.chain.submit).not.toHaveBeenCalled();
  await f.service.tick();expect(f.chain.prepare).toHaveBeenCalledTimes(1);
  expect(await f.service.status(f.owner)).toMatchObject({status:'SUBMITTED'});
 });
 it('keeps preparation failures pending and never claims that unavailable treasury funds were allocated',async()=>{
  const f=await fixture();await f.service.queue(f.owner);f.chain.prepare.mockRejectedValueOnce(Error('Insufficient treasury balance'));
  await f.service.tick();expect(await f.service.status(f.owner)).toMatchObject({status:'PENDING'});expect(f.chain.submit).not.toHaveBeenCalled();
 });
});
