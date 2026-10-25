import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { db } from '../store.js';
import { TESTNET_PASSPHRASE } from '../config.js';

/** Prepared, fully signed Stellar transaction. No private key is stored in the database. */
export type PreparedDeployment = Readonly<{
  signedXdr:string; transactionHash:string; contractAddress:string; networkPassphrase:string;
}>;
export interface DeploymentChainAdapter {
  prepare(accountID:string):Promise<PreparedDeployment>;
  lookup(transactionHash:string):Promise<'SUCCESS'|'FAILED'|'NOT_FOUND'|'PENDING'>;
  broadcast(signedXdr:string):Promise<void>;
  verifyContractAndSigners(accountID:string,contractAddress:string):Promise<boolean>;
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Durable outbox: persistence commits BEFORE any network broadcast. */
export class DeploymentOutbox {
  constructor(private readonly pool:Pick<Pool,'connect'> = db) {}
  async persist(accountID:string,leaseToken:string,intent:PreparedDeployment):Promise<boolean> {
    if(intent.networkPassphrase!==TESTNET_PASSPHRASE)throw Error('TESTNET_ONLY');
    if(!/^[a-f0-9]{64}$/.test(intent.transactionHash) || !/^C[A-Z2-7]{55}$/.test(intent.contractAddress)
      || !intent.signedXdr || intent.signedXdr.length>100000)throw Error('INVALID_DEPLOYMENT_INTENT');
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result=await client.query(`UPDATE wallet_deployment_jobs SET signed_envelope=$3,
        intent_hash=$4,envelope_hash=$5,transaction_hash=$6,contract_address=$7,updated_at=NOW()
        WHERE account_id=$1 AND lease_token=$2 AND status='DEPLOYING' AND signed_envelope IS NULL`,
        [accountID,leaseToken,intent.signedXdr,sha(accountID+':'+intent.transactionHash),sha(intent.signedXdr),
          intent.transactionHash,intent.contractAddress]);
      if(result.rowCount!==1){await client.query('ROLLBACK');return false;}
      await client.query(`INSERT INTO wallet_deployment_events(account_id,from_status,to_status,event_code)
        VALUES($1,'DEPLOYING','DEPLOYING','SIGNED_INTENT_PERSISTED')`,[accountID]);
      await client.query('COMMIT');return true;
    }catch(e){await client.query('ROLLBACK');throw e;}
    finally{client.release();}
  }
  /** All unknown outcomes are reconciled before any attempt to rebroadcast. */
  async reconcile(accountID:string,chain:DeploymentChainAdapter):Promise<'CONFIRMED'|'FAILED'|'PENDING'|'UNKNOWN'> {
    const client=await this.pool.connect();
    try{
      const {rows}=await client.query<{transaction_hash:string|null;signed_envelope:string|null;contract_address:string|null;status:string}>(
        'SELECT transaction_hash,signed_envelope,contract_address,status FROM wallet_deployment_jobs WHERE account_id=$1',[accountID]);
      const job=rows[0];
      if(!job?.transaction_hash || !job.signed_envelope)return 'UNKNOWN';
      const result=await chain.lookup(job.transaction_hash);
      if(result==='NOT_FOUND' || result==='PENDING')return 'PENDING';
      await client.query('BEGIN');
      const next=result==='SUCCESS'?'CONFIRMED':'FAILED';
      const updated=await client.query(`UPDATE wallet_deployment_jobs SET status=$2,last_reconciled_at=NOW(),
        lease_token=NULL,lease_until=NULL,updated_at=NOW(),last_transition_at=NOW()
        WHERE account_id=$1 AND transaction_hash=$3 AND status IN ('DEPLOYING','SUBMITTED')`,
        [accountID,next,job.transaction_hash]);
      if(updated.rowCount===1)await client.query(`INSERT INTO wallet_deployment_events(account_id,from_status,to_status,event_code)
        VALUES($1,$2,$3,'CHAIN_TRANSACTION_RECONCILED')`,[accountID,job.status,next]);
      await client.query('COMMIT');
      return next;
    }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}
    finally{client.release();}
  }
}
