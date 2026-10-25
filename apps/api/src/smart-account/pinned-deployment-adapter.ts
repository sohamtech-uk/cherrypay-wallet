import { StrKey, rpc } from '@stellar/stellar-sdk';
import { TESTNET_PASSPHRASE, TESTNET_RPC_URL } from '../config.js';
import { db } from '../store.js';
import { PinnedAccountAdapter, ACCOUNT_V080_HASH, type ApprovedAccount } from './pinned-adapter.js';
import { TESTNET_V080, validateKitV080DeploymentConfig } from './kit-v080-preflight.js';
import type { DeploymentChainAdapter, PreparedDeployment } from './deployment-outbox.js';

export type PinnedDeploymentBuilder = (ownerEmail:string, credentials:readonly {id:string;public_key:string}[])=>Promise<PreparedDeployment>;

/** Uses only the reviewed v0.8.0 WASM and verifier. Never substitutes the blocked legacy WASM. */
export class PinnedV080DeploymentAdapter implements DeploymentChainAdapter {
  constructor(private readonly builder:PinnedDeploymentBuilder,
    private readonly server=new rpc.Server(TESTNET_RPC_URL,{timeout:20})) {
    validateKitV080DeploymentConfig({
      networkPassphrase:TESTNET_PASSPHRASE,accountWasmHash:ACCOUNT_V080_HASH,
      verifierAddress:TESTNET_V080.verifierAddress,verifierWasmHash:TESTNET_V080.verifierWasmHash,
    });
  }
  async prepare(ownerEmail:string):Promise<PreparedDeployment>{
    const {rows}=await db.query<{id:string;public_key:string}>(
      'SELECT id,public_key FROM wallet_credentials WHERE account_id=$1 ORDER BY created_at,id',[ownerEmail]);
    if(rows.length!==2 || rows[0].id===rows[1].id)throw Error('TWO_INDEPENDENT_PASSKEYS_REQUIRED');
    const prepared=await this.builder(ownerEmail,rows);
    if(prepared.networkPassphrase!==TESTNET_PASSPHRASE || !StrKey.isValidContract(prepared.contractAddress))
      throw Error('UNAPPROVED_DEPLOYMENT');
    return prepared;
  }
  async lookup(transactionHash:string):Promise<'SUCCESS'|'FAILED'|'NOT_FOUND'|'PENDING'>{
    const network=await this.server.getNetwork();
    if(network.passphrase!==TESTNET_PASSPHRASE)throw Error('RPC_NETWORK_MISMATCH');
    const result=await this.server.getTransaction(transactionHash);
    return result.status==='SUCCESS'?'SUCCESS':result.status==='FAILED'?'FAILED':
      result.status==='NOT_FOUND'?'NOT_FOUND':'PENDING';
  }
  async broadcast(signedXdr:string):Promise<void>{
    const network=await this.server.getNetwork();
    if(network.passphrase!==TESTNET_PASSPHRASE)throw Error('RPC_NETWORK_MISMATCH');
    const { TransactionBuilder }=await import('@stellar/stellar-sdk');
    const transaction=TransactionBuilder.fromXDR(signedXdr,TESTNET_PASSPHRASE);
    const result=await this.server.sendTransaction(transaction);
    if(result.status==='ERROR')throw Error('DEPLOYMENT_BROADCAST_REJECTED');
  }
  /** Existing PinnedAccountAdapter validates both independent on-chain rules and pinned WASM. */
  async verifyContractAndSigners(ownerEmail:string,address:string):Promise<boolean>{
    const {rows}=await db.query<{id:string;owner:string;primary_credential_id:string;backup_credential_id:string;
      deployment_transaction_hash:string;recovery_transaction_hash:string;wallet_id:string;
      primary_rule_id:number;backup_rule_id:number}>(`SELECT * FROM wallet_deployment_approvals
      WHERE owner=$1 AND contract_address=$2`,[ownerEmail,address]);
    const a=rows[0];
    if(!a || a.deployment_transaction_hash===a.recovery_transaction_hash)return false;
    const approved:ApprovedAccount={
      walletId:a.wallet_id,owner:a.owner,address,accountWasmHash:ACCOUNT_V080_HASH,
      verifierAddress:TESTNET_V080.verifierAddress,verifierWasmHash:TESTNET_V080.verifierWasmHash,
      primaryRuleId:a.primary_rule_id,backupRuleId:a.backup_rule_id,
      primaryCredentialId:a.primary_credential_id,backupCredentialId:a.backup_credential_id,
      deploymentTransactionHash:a.deployment_transaction_hash,recoveryTransactionHash:a.recovery_transaction_hash,
    };
    const policy=await new PinnedAccountAdapter(this.server,[approved]).current(address);
    return policy.recoveryReady && /^[a-f0-9]{64}$/.test(policy.fingerprint);
  }
}
