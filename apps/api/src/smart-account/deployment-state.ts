import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { db } from '../store.js';

export type DeploymentState = 'AWAITING_PASSKEY'|'PENDING'|'DEPLOYING'|'SUBMITTED'|'CONFIRMED'|'VERIFYING'|'ACTIVE'|'RETRYABLE_FAILURE'|'FAILED';
type Job = { account_id:string; status:DeploymentState; lease_token:string|null; transaction_hash:string|null; contract_address:string|null; attempt_count:number };
const allowed: Record<DeploymentState, readonly DeploymentState[]> = {
  AWAITING_PASSKEY:['PENDING'], PENDING:['DEPLOYING'], DEPLOYING:['SUBMITTED','RETRYABLE_FAILURE','FAILED'],
  SUBMITTED:['CONFIRMED','FAILED'], CONFIRMED:['VERIFYING'],
  VERIFYING:['ACTIVE','RETRYABLE_FAILURE','FAILED'], ACTIVE:[],
  RETRYABLE_FAILURE:['DEPLOYING'], FAILED:[],
};
/** SQL fencing ensures an expired worker cannot overwrite its replacement. */
export class DeploymentStateStore {
  constructor(private readonly pool: Pick<Pool,'connect'> = db) {}
  async claim():Promise<(Job & { token:string })|null> {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const {rows}=await client.query<Job>(`SELECT * FROM wallet_deployment_jobs
        WHERE (status='PENDING' OR (status='RETRYABLE_FAILURE' AND (retry_after IS NULL OR retry_after<=NOW())))
          AND (lease_until IS NULL OR lease_until<NOW())
        ORDER BY created_at,account_id FOR UPDATE SKIP LOCKED LIMIT 1`);
      const job=rows[0];
      if(!job){await client.query('COMMIT');return null;}
      // Never claim a retry whose prior transaction may already exist on-chain.\n      if(job.transaction_hash){await client.query('ROLLBACK');throw Error('RECONCILIATION_REQUIRED_BEFORE_RETRY');}\n      const token=randomUUID();
      await client.query(`UPDATE wallet_deployment_jobs SET status='DEPLOYING',lease_token=$2,
        lease_until=NOW()+INTERVAL '2 minutes',attempt_count=attempt_count+1,updated_at=NOW(),last_transition_at=NOW()
        WHERE account_id=$1`,[job.account_id,token]);
      await client.query(`INSERT INTO wallet_deployment_events(account_id,from_status,to_status,event_code)
        VALUES($1,$2,'DEPLOYING','WORKER_CLAIMED')`,[job.account_id,job.status]);
      await client.query('COMMIT');
      return {...job,status:'DEPLOYING',attempt_count:job.attempt_count+1,lease_token:token,token};
    } catch(e){await client.query('ROLLBACK');throw e;}
    finally{client.release();}
  }
  async transition(accountID:string, token:string, next:DeploymentState, opts:{
    transactionHash?:string;contractAddress?:string;failureCode?:string;retryAfterSeconds?:number;
  }={}):Promise<boolean>{
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      const {rows}=await client.query<Job>('SELECT * FROM wallet_deployment_jobs WHERE account_id=$1 FOR UPDATE',[accountID]);
      const current=rows[0];
      if(!current || current.lease_token!==token || !allowed[current.status].includes(next)) {
        await client.query('ROLLBACK');return false;
      }
      const hash=opts.transactionHash??current.transaction_hash;
      const address=opts.contractAddress??current.contract_address;
      if(['SUBMITTED','CONFIRMED','VERIFYING','ACTIVE'].includes(next) && !hash) throw Error('TRANSACTION_EVIDENCE_REQUIRED');
      if(['CONFIRMED','VERIFYING','ACTIVE'].includes(next) && !address) throw Error('CONTRACT_ADDRESS_REQUIRED');
      // ACTIVE must be gated by independent on-chain verifier; never transition via generic state-store API.
      if(next==='ACTIVE') throw Error('VERIFIED_ACTIVATION_REQUIRED');
      if(next==='RETRYABLE_FAILURE' && hash) throw Error('RECONCILIATION_REQUIRED_BEFORE_RETRY');\n      const retry=next==='RETRYABLE_FAILURE';
      await client.query(`UPDATE wallet_deployment_jobs SET status=$3,transaction_hash=$4,contract_address=$5,
        failure_code=$6,retry_after=CASE WHEN $7::int IS NULL THEN NULL ELSE NOW()+($7::int * INTERVAL '1 second') END,
        lease_token=CASE WHEN $8 THEN NULL ELSE lease_token END,
        lease_until=CASE WHEN $8 THEN NULL ELSE NOW()+INTERVAL '2 minutes' END,
        updated_at=NOW(),last_transition_at=NOW() WHERE account_id=$1 AND lease_token=$2`,
        [accountID,token,next,hash,address,opts.failureCode??null,retry?Math.max(30,opts.retryAfterSeconds??60):null,retry||next==='FAILED']);
      await client.query('INSERT INTO wallet_deployment_events(account_id,from_status,to_status,event_code) VALUES($1,$2,$3,$4)',
        [accountID,current.status,next,opts.failureCode??'STATE_TRANSITION']);
      await client.query('COMMIT');
      return true;
    }catch(e){await client.query('ROLLBACK');throw e;}
    finally{client.release();}
  }
}
