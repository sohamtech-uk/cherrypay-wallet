import type { Pool } from 'pg';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { db } from '../store.js';
import { TESTNET_RPC_URL } from '../config.js';
import { PASSPHRASE, requireThat, spendingReady, type PolicyReader } from '../payments/model.js';
import { PostgresPaymentRepository } from '../payments/postgres-repository.js';
import { PaymentService } from '../payments/service.js';
import { StellarChain } from '../payments/stellar.js';
import { ACCOUNT_V080_HASH, PinnedAccountAdapter, type PrimaryAccount } from './pinned-adapter.js';
import { validateDeploymentDescriptor, type DeploymentDescriptor } from './automatic-deployment-chain.js';
import type { AutomaticDeploymentService } from './automatic-deployment.js';

/** Activation is derived from a durable, verified deployment and current on-chain
 * primary policy. Funding, email login and a second off-chain credential are not authority. */
export class PrimaryWalletRegistry {
  constructor(readonly pool: Pool = db) {}
  async resolve(address: string): Promise<PrimaryAccount | undefined> {
    const {rows}=await this.pool.query(`SELECT d.*,c.public_key FROM wallet_deployment_jobs d
      JOIN wallet_credentials c ON c.id=d.descriptor->>'credentialId' AND c.account_id=d.account_id
      WHERE d.contract_address=$1 AND d.status='CONFIRMED' AND d.binding_verified_at IS NOT NULL`,[address]);
    if(!rows.length)return;
    const r=rows[0],d=r.descriptor as DeploymentDescriptor;
    validateDeploymentDescriptor(d);
    requireThat(rows.length===1 && d.owner===r.account_id && d.address===address && d.credentialPublicKey===r.public_key &&
      r.signer_rule_id===0 && Number(r.confirmed_ledger)>0 && /^[a-f0-9]{64}$/.test(r.transaction_hash),'INVALID_PRIMARY_DEPLOYMENT_BINDING');
    return {mode:'primary-passkey',walletId:address,owner:d.owner,address,accountWasmHash:ACCOUNT_V080_HASH,
      verifierAddress:d.verifierAddress,verifierWasmHash:d.verifierWasmHash,primaryRuleId:0,
      primaryCredentialId:d.credentialId,deploymentTransactionHash:r.transaction_hash};
  }
  async ensure(owner:string,policies:PolicyReader) {
    const {rows}=await this.pool.query("SELECT contract_address FROM wallet_deployment_jobs WHERE account_id=$1 AND status='CONFIRMED' AND binding_verified_at IS NOT NULL",[owner]);
    if(!rows.length)return;
    const account=await this.resolve(rows[0].contract_address);
    requireThat(account && account.owner===owner,'PRIMARY_WALLET_NOT_VERIFIED');
    const policy=await policies.current(account.address);
    requireThat(spendingReady(policy) && policy.recoveryReady===false && /^[a-f0-9]{64}$/.test(policy.fingerprint),'PRIMARY_POLICY_UNAVAILABLE');
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const deployment=await client.query("SELECT descriptor,transaction_hash FROM wallet_deployment_jobs WHERE account_id=$1 AND status='CONFIRMED' AND binding_verified_at IS NOT NULL FOR UPDATE",[owner]);
      requireThat(deployment.rows[0]?.descriptor?.address===account.address && deployment.rows[0]?.descriptor?.credentialId===account.primaryCredentialId &&
        deployment.rows[0]?.transaction_hash===account.deploymentTransactionHash,'PRIMARY_DEPLOYMENT_CHANGED');
      // Never overwrite a previously pinned fingerprint or operator-provisioned wallet.
      await client.query(`INSERT INTO wallet_onchain_accounts(id,owner,network,address,policy,routes,created_at)
        VALUES($1,$2,'TESTNET',$1,$3,'["classic","contract"]'::jsonb,$4) ON CONFLICT DO NOTHING`,[account.walletId,owner,policy.fingerprint,Date.now()]);
      const current=await client.query('SELECT * FROM wallet_onchain_accounts WHERE id=$1 OR address=$1 FOR UPDATE',[account.address]);
      const w=current.rows[0];
      requireThat(current.rows.length===1 && w.id===account.walletId && w.owner===owner && w.address===account.address &&
        w.network==='TESTNET' && w.policy===policy.fingerprint && JSON.stringify(w.routes)==='["classic","contract"]','EXISTING_WALLET_BINDING_CONFLICT');
      await client.query('COMMIT');
      return account.walletId;
    } catch(error) { await client.query('ROLLBACK');throw error; } finally { client.release(); }
  }
  async sync(policies:PolicyReader) {
    const {rows}=await this.pool.query(`SELECT d.account_id FROM wallet_deployment_jobs d
      LEFT JOIN wallet_onchain_accounts w ON w.address=d.contract_address
      WHERE d.status='CONFIRMED' AND d.binding_verified_at IS NOT NULL AND w.id IS NULL LIMIT 100`);
    for(const row of rows) {
      try { await this.ensure(row.account_id,policies); }
      catch { /* Keep the invalid wallet unavailable; do not block other owners or reconciliation. */ }
    }
  }
}

/** Persist the first scan boundary. Restarts must never skip older deposits or
 * reset an existing cursor to conceal a retention gap. */
export async function paymentMonitorStart(pool:Pool,latestLedger:()=>Promise<number>) {
  const existing=await pool.query("SELECT start_ledger FROM wallet_monitor_cursors WHERE id='TESTNET:native_xlm_sac:monitor'");
  let start=Number(existing.rows[0]?.start_ledger);
  if(!start) {
    const earliest=await pool.query("SELECT min(confirmed_ledger) AS ledger FROM wallet_deployment_jobs WHERE status='CONFIRMED' AND binding_verified_at IS NOT NULL");
    start=Number(earliest.rows[0].ledger) || await latestLedger();
    requireThat(Number.isSafeInteger(start) && start>0,'INVALID_MONITOR_START_LEDGER');
    const saved=await pool.query(`INSERT INTO wallet_monitor_cursors(id,start_ledger) VALUES('TESTNET:native_xlm_sac:monitor',$1)
      ON CONFLICT(id) DO UPDATE SET start_ledger=COALESCE(wallet_monitor_cursors.start_ledger,EXCLUDED.start_ledger) RETURNING start_ledger`,[start]);
    start=Number(saved.rows[0].start_ledger);
  }
  requireThat(Number.isSafeInteger(start) && start>0,'INVALID_MONITOR_START_LEDGER');
  return start;
}

export async function configuredPrimaryPayments(env:NodeJS.ProcessEnv,deployments:AutomaticDeploymentService|undefined) {
  requireThat(env.WALLET_PRIMARY_PAYMENTS_ENABLED===undefined || ['true','false'].includes(env.WALLET_PRIMARY_PAYMENTS_ENABLED),'INVALID_PRIMARY_PAYMENT_FLAG');
  if(env.WALLET_PRIMARY_PAYMENTS_ENABLED!=='true')return;
  requireThat(deployments && env.WALLET_PAYMENTS_ENABLED!=='true' && !env.WALLET_PAYMENT_MANIFEST,'PRIMARY_PAYMENT_MODE_CONFLICT');
  requireThat(env.STELLAR_RELAYER_SECRET && env.STELLAR_RELAYER_PUBLIC_KEY,'PAYMENT_RELAYER_CONFIGURATION_REQUIRED');
  const key=Keypair.fromSecret(env.STELLAR_RELAYER_SECRET);
  requireThat(key.publicKey()===env.STELLAR_RELAYER_PUBLIC_KEY && key.publicKey()!==env.STELLAR_DEPLOYER_PUBLIC_KEY,'DEDICATED_PAYMENT_RELAYER_REQUIRED');
  const server=new rpc.Server(TESTNET_RPC_URL,{timeout:20});
  requireThat((await server.getNetwork()).passphrase===PASSPHRASE,'RPC_NETWORK_MISMATCH');
  await server.getAccount(key.publicKey()); // Fail startup if the fee sponsor is not funded.
  const registry=new PrimaryWalletRegistry();
  const codec=new PinnedAccountAdapter(server,address=>registry.resolve(address));
  const store=new PostgresPaymentRepository();
  const start=await paymentMonitorStart(db,async()=>(await server.getLatestLedger()).sequence);
  const service=new PaymentService(store,new StellarChain(server,key),codec,start,()=>registry.sync(codec));
  deployments.paymentAccess=async owner=>{
    const walletId=await registry.ensure(owner,codec);
    return walletId ? {spendingEnabled:true,walletId} : {spendingEnabled:false};
  };
  return {payments:service,passkeyCodec:codec,
    ensureOwnerWallet:async(owner:string)=>{await registry.ensure(owner,codec);},
    receiveRoute:async(walletId:string,owner:string)=>{
      const wallet=await store.wallet(walletId,owner),policy=await codec.current(wallet.address);
      requireThat(spendingReady(policy) && policy.fingerprint===wallet.policy,'SIGNER_POLICY_CHANGED_OR_RECOVERY_UNREADY');
      return {address:wallet.address,route:'contract' as const,instructions:'Receive Testnet XLM from another Cherry Pay wallet or a native XLM Stellar Asset Contract transfer to this C-address. Classic payment operations are not supported.'};
    },
  };
}
