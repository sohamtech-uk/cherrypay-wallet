import type { DeploymentChainAdapter, PreparedDeployment } from './deployment-outbox.js';
import { DeploymentOutbox } from './deployment-outbox.js';
import { DeploymentStateStore } from './deployment-state.js';

/** A single attempt may be prepared once; never create a replacement for an uncertain broadcast. */
export class DeploymentCoordinator {
  constructor(private readonly chain:DeploymentChainAdapter,
    private readonly states=new DeploymentStateStore(),private readonly outbox=new DeploymentOutbox()) {}
  async processOne():Promise<'IDLE'|'SUBMITTED'|'RECONCILE_REQUIRED'> {
    const job=await this.states.claim();
    if(!job)return 'IDLE';
    // An old signed intent must be reconciled rather than preparing another contract.
    if(job.transaction_hash)return 'RECONCILE_REQUIRED';
    let prepared:PreparedDeployment;
    try{prepared=await this.chain.prepare(job.account_id);}
    catch{await this.states.transition(job.account_id,job.token,'RETRYABLE_FAILURE',{failureCode:'PREPARATION_FAILED',retryAfterSeconds:60});return 'IDLE';}
    if(!await this.outbox.persist(job.account_id,job.token,prepared))return 'RECONCILE_REQUIRED';
    // Persist SUBMITTED before broadcasting; after a crash, reconcile by transaction hash.
    if(!await this.states.transition(job.account_id,job.token,'SUBMITTED',{transactionHash:prepared.transactionHash,
      contractAddress:prepared.contractAddress}))return 'RECONCILE_REQUIRED';
    try{await this.chain.broadcast(prepared.signedXdr);}
    catch{return 'RECONCILE_REQUIRED';}
    return 'SUBMITTED';
  }
}
