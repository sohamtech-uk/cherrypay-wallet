import type { Pool } from 'pg';
import { Keypair, rpc, StrKey, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { db } from '../store.js';
import { PASSPHRASE, requireThat, type Outcome } from '../payments/model.js';
import { transferOperation, verifyOutcome } from '../payments/stellar.js';
import type { DeploymentDescriptor } from './automatic-deployment-chain.js';

export const TESTNET_ALLOCATION_STROOPS = '1000000000000';
type Prepared = {signedXdr:string;transactionHash:string;expiresAt:number};
export interface FundingChain {
  source:string;
  verify(descriptor:DeploymentDescriptor,ledger:number):Promise<void>;
  prepare(address:string):Promise<Prepared>;
  submit(prepared:Prepared):Promise<void>;
  outcome(hash:string):Promise<Outcome>;
}
export type FundingStatus = {status:'AVAILABLE'|'PENDING'|'SUBMITTED'|'FUNDED'|'FAILED';amountStroops:string;transactionHash?:string;ledger?:number};
export function verifyAllocation(outcome:Outcome,source:string,address:string) {
  requireThat(outcome.status==='SUCCESS','FUNDING_NOT_CONFIRMED');
  const events=outcome.events.filter(e=>e.from===source&&e.to===address&&e.amountStroops===TESTNET_ALLOCATION_STROOPS);
  requireThat(events.length===1&&outcome.events.length===1,'FUNDING_RECEIPT_MISMATCH');
  requireThat(Number.isSafeInteger(events[0].ledger)&&events[0].ledger>0,'INVALID_FUNDING_LEDGER');
  return events[0].ledger;
}
/** Funding authority belongs only to the dedicated Testnet treasury, never the user's wallet. */
export class StellarFundingChain implements FundingChain {
  readonly source:string;
  constructor(readonly server:rpc.Server,private readonly key:Keypair,readonly verify:FundingChain['verify']) {this.source=key.publicKey();}
  async network() {requireThat((await this.server.getNetwork()).passphrase===PASSPHRASE,'RPC_NETWORK_MISMATCH');}
  async prepare(address:string):Promise<Prepared> {
    requireThat(StrKey.isValidContract(address),'CONTRACT_ADDRESS_REQUIRED');await this.network();
    const tx=new TransactionBuilder(await this.server.getAccount(this.source),{fee:'100',networkPassphrase:PASSPHRASE})
      .addOperation(transferOperation(this.source,address,TESTNET_ALLOCATION_STROOPS)).setTimeout(120).build();
    const sim=await this.server.simulateTransaction(tx,undefined,'enforce');
    requireThat(rpc.Api.isSimulationSuccess(sim)&&!rpc.Api.isSimulationRestore(sim),'FUNDING_SIMULATION_UNAVAILABLE');
    const assembled=rpc.assembleTransaction(tx,sim).build();
    requireThat(BigInt(assembled.fee)<=10000000n,'FUNDING_FEE_CAP_EXCEEDED');
    const ops=assembled.toEnvelope().v1().tx().operations();
    requireThat(assembled.source===this.source&&ops.length===1&&!ops[0].sourceAccount(),'FUNDING_TRANSACTION_CHANGED');
    const op=ops[0].body().invokeHostFunctionOp();
    requireThat(op.hostFunction().toXDR('base64')===transferOperation(this.source,address,TESTNET_ALLOCATION_STROOPS).body().invokeHostFunctionOp().hostFunction().toXDR('base64'),'FUNDING_INTENT_CHANGED');
    requireThat(op.auth().every(a=>a.credentials().switch().name==='sorobanCredentialsSourceAccount'),'UNEXPECTED_FUNDING_AUTHORIZATION');
    assembled.sign(this.key);
    return {signedXdr:assembled.toXDR(),transactionHash:assembled.hash().toString('hex'),expiresAt:Number(assembled.timeBounds!.maxTime)*1000};
  }
  async submit(p:Prepared) {
    await this.network();const tx=new Transaction(p.signedXdr,PASSPHRASE);
    requireThat(tx.hash().toString('hex')===p.transactionHash,'FUNDING_HASH_MISMATCH');
    const result=await this.server.sendTransaction(tx);
    requireThat(result.hash===p.transactionHash,'FUNDING_SUBMISSION_UNCERTAIN');
  }
  async outcome(hash:string) {await this.network();return verifyOutcome(hash,await this.server.getTransaction(hash));}
}
export class ContractFundingService {
  constructor(readonly chain:FundingChain,readonly pool:Pool=db) {}
  async queue(owner:string) {
    const result=await this.pool.query(`INSERT INTO wallet_contract_funding(account_id,address,source)
      SELECT account_id,contract_address,$2 FROM wallet_deployment_jobs
      WHERE account_id=$1 AND status='CONFIRMED' AND binding_verified_at IS NOT NULL
      ON CONFLICT DO NOTHING`,[owner,this.chain.source]);
    if(!result.rowCount) {
      const existing=await this.pool.query('SELECT account_id FROM wallet_contract_funding WHERE account_id=$1',[owner]);
      requireThat(existing.rowCount===1,'VERIFIED_C_WALLET_REQUIRED',409);
    }
    return this.status(owner);
  }
  async status(owner:string):Promise<FundingStatus> {
    const {rows}=await this.pool.query('SELECT status,amount_stroops,transaction_hash,ledger FROM wallet_contract_funding WHERE account_id=$1',[owner]);
    const r=rows[0];return r?{status:r.status,amountStroops:r.amount_stroops,transactionHash:r.transaction_hash??undefined,ledger:r.ledger?Number(r.ledger):undefined}:{status:'AVAILABLE',amountStroops:TESTNET_ALLOCATION_STROOPS};
  }
  async tick() {
    const client=await this.pool.connect();let locked=false;
    try {
      // Session lock serializes preparation/checkpoint/broadcast across API replicas.
      // A saved SUBMITTED row also reserves the sequence after a process dies.
      const lock=await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',['cherrypay-testnet-funding:'+this.chain.source]);
      locked=lock.rows[0].locked;if(!locked)return;
      const {rows}=await client.query(`SELECT f.*,d.descriptor,d.confirmed_ledger FROM wallet_contract_funding f
        JOIN wallet_deployment_jobs d ON d.account_id=f.account_id WHERE f.source=$1 AND f.status IN ('PENDING','SUBMITTED')
        ORDER BY (f.status='SUBMITTED') DESC,f.requested_at,f.account_id LIMIT 1`,[this.chain.source]);
      const j=rows[0];if(!j)return;
      try {
        let p:Prepared;
        if(j.signed_xdr) p={signedXdr:j.signed_xdr,transactionHash:j.transaction_hash,expiresAt:Number(j.expires_at)};
        else {
          requireThat(j.descriptor?.owner===j.account_id&&j.descriptor?.address===j.address,'INVALID_FUNDING_BINDING');
          await this.chain.verify(j.descriptor,Number(j.confirmed_ledger));
          p=await this.chain.prepare(j.address);
          // Persist before external submission. A lost commit acknowledgement must not send.
          const checkpoint=await client.query(`UPDATE wallet_contract_funding SET status='SUBMITTED',signed_xdr=$2,transaction_hash=$3,expires_at=$4
            WHERE account_id=$1 AND status='PENDING'`,[j.account_id,p.signedXdr,p.transactionHash,p.expiresAt]);
          requireThat(checkpoint.rowCount===1,'FUNDING_CHECKPOINT_NOT_COMMITTED');
        }
        const outcome=await this.chain.outcome(p.transactionHash);
        if(outcome.status==='SUCCESS') {
          const ledger=verifyAllocation(outcome,this.chain.source,j.address);
          await client.query("UPDATE wallet_contract_funding SET status='FUNDED',ledger=$2,verified_at=NOW(),failure_code=NULL WHERE account_id=$1",[j.account_id,ledger]);
        } else if(outcome.status==='FAILED') {
          await client.query("UPDATE wallet_contract_funding SET status='FAILED',failure_code='FUNDING_TRANSACTION_FAILED' WHERE account_id=$1",[j.account_id]);
        } else if(p.expiresAt>Date.now()) {
          await this.chain.submit(p); // Rebroadcast only the identical durable envelope.
        } else {
          await client.query("UPDATE wallet_contract_funding SET failure_code='FUNDING_OUTCOME_UNRESOLVED' WHERE account_id=$1",[j.account_id]);
        }
      } catch {
        await client.query("UPDATE wallet_contract_funding SET failure_code='FUNDING_RPC_OR_TREASURY_UNAVAILABLE' WHERE account_id=$1",[j.account_id]);
      }
    } finally {
      // Destroy the connection if unlock fails; never return a held lock to the pool.
      if(locked) {try{await client.query('SELECT pg_advisory_unlock(hashtext($1))',['cherrypay-testnet-funding:'+this.chain.source]);}catch{client.release(true);return;}}
      client.release();
    }
  }
}
