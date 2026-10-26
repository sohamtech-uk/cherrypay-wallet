import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { db } from '../store.js';
import { requireThat } from '../payments/model.js';
import { deploymentDescriptor, validateDeploymentDescriptor, type DeploymentDescriptor, type DeploymentOutcome, type PreparedDeployment } from './automatic-deployment-chain.js';

export type DeploymentJob = {
  owner: string; status: string; descriptor?: DeploymentDescriptor;
  prepared?: PreparedDeployment; leaseToken?: string;
  confirmedLedger?: number; signerRuleId?: number; bindingVerified: boolean; failureCode?: string;
};
export interface DeploymentStore {
  queue(owner: string): Promise<DeploymentJob>;
  get(owner: string): Promise<DeploymentJob | undefined>;
  claim(): Promise<DeploymentJob | undefined>;
  assertBinding(job: DeploymentJob): Promise<void>;
  checkpoint(job: DeploymentJob, prepared: PreparedDeployment): Promise<DeploymentJob>;
  settle(job: DeploymentJob, outcome: Exclude<DeploymentOutcome, { status: 'NOT_FOUND' }>): Promise<void>;
  retry(job: DeploymentJob, code: string): Promise<void>;
}
type Row = { account_id: string; status: string; descriptor: DeploymentDescriptor | null; signed_xdr: string | null;
  transaction_hash: string | null; expires_at: string | null; lease_token: string | null;
  confirmed_ledger: string | null; signer_rule_id: number | null; binding_verified_at: Date | null; failure_code: string | null };
function job(row: Row): DeploymentJob {
  return { owner: row.account_id, status: row.status, descriptor: row.descriptor ?? undefined,
    prepared: row.signed_xdr && row.transaction_hash && row.expires_at ? { signedXdr: row.signed_xdr, transactionHash: row.transaction_hash, expiresAt: Number(row.expires_at) } : undefined,
    leaseToken: row.lease_token ?? undefined, confirmedLedger: row.confirmed_ledger ? Number(row.confirmed_ledger) : undefined,
    signerRuleId: row.signer_rule_id ?? undefined, bindingVerified: row.binding_verified_at != null, failureCode: row.failure_code ?? undefined };
}
async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
/** Dedicated deployment fee source, separate from the payment relayer.
 * No SQL transaction or row lock is held while an RPC request executes. */
export class PostgresDeploymentStore implements DeploymentStore {
  constructor(readonly publicKey: string, readonly pool: Pool = db, readonly limit = 0) {
    requireThat(Number.isSafeInteger(limit) && limit >= 0 && limit <= 1000, 'INVALID_DEPLOYMENT_LIMIT');
  }
  async get(owner: string): Promise<DeploymentJob | undefined> {
    const { rows } = await this.pool.query<Row>('SELECT * FROM wallet_deployment_jobs WHERE account_id=$1', [owner]);
    return rows[0] ? job(rows[0]) : undefined;
  }
  async queue(owner: string): Promise<DeploymentJob> {
    return transaction(this.pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('cherrypay-deployment-queue:' || $1))", [this.publicKey]);
      const owned = await client.query('SELECT id FROM wallet_accounts WHERE id=$1 FOR UPDATE', [owner]);
      requireThat(owned.rowCount === 1, 'DEPLOYMENT_OWNER_NOT_FOUND', 404);
      const credentials = await client.query<{ id: string; public_key: string }>('SELECT id,public_key FROM wallet_credentials WHERE account_id=$1 ORDER BY created_at,id FOR SHARE', [owner]);
      const existing = await client.query<Row>('SELECT * FROM wallet_deployment_jobs WHERE account_id=$1 FOR UPDATE', [owner]);
      if (existing.rows[0]?.descriptor) {
        const d = existing.rows[0].descriptor;
        validateDeploymentDescriptor(d);
        requireThat(d.owner === owner && d.deployerPublicKey === this.publicKey && credentials.rows.some(c => c.id === d.credentialId && c.public_key === d.credentialPublicKey), 'DEPLOYMENT_CREDENTIAL_BINDING_CHANGED');
        return job(existing.rows[0]);
      }
      requireThat(!existing.rows[0] || ['PENDING','AWAITING_PASSKEY'].includes(existing.rows[0].status), 'LEGACY_DEPLOYMENT_REQUIRES_REVIEW');
      const deployed = await client.query('SELECT id FROM wallet_onchain_accounts WHERE owner=$1 LIMIT 1', [owner]);
      requireThat(deployed.rowCount === 0, 'EXISTING_WALLET_REQUIRES_REVIEW');
      if (!credentials.rows.length) {
        const result = await client.query<Row>("INSERT INTO wallet_deployment_jobs(account_id,status) VALUES($1,'AWAITING_PASSKEY') ON CONFLICT(account_id) DO UPDATE SET status='AWAITING_PASSKEY',updated_at=NOW() RETURNING *", [owner]);
        return job(result.rows[0]);
      }
      const count = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM wallet_deployment_jobs WHERE descriptor->>'deployerPublicKey'=$1", [this.publicKey]);
      requireThat(this.limit === 0 || count.rows[0].count < this.limit, 'DEPLOYMENT_PILOT_LIMIT_REACHED', 429);
      const descriptor = deploymentDescriptor(owner, credentials.rows[0], this.publicKey);
      const result = await client.query<Row>(`INSERT INTO wallet_deployment_jobs(account_id,status,descriptor) VALUES($1,'PENDING',$2::jsonb)
        ON CONFLICT(account_id) DO UPDATE SET status='PENDING',descriptor=EXCLUDED.descriptor,updated_at=NOW(),next_attempt_at=NOW(),failure_code=NULL RETURNING *`, [owner, JSON.stringify(descriptor)]);
      return job(result.rows[0]);
    });
  }
  async claim(): Promise<DeploymentJob | undefined> {
    return transaction(this.pool, async client => {
      await client.query('INSERT INTO wallet_deployment_sponsors(public_key) VALUES($1) ON CONFLICT DO NOTHING', [this.publicKey]);
      const slot = await client.query<{ account_id: string | null }>('SELECT account_id FROM wallet_deployment_sponsors WHERE public_key=$1 FOR UPDATE', [this.publicKey]);
      let owner = slot.rows[0].account_id;
      if (!owner) {
        const next = await client.query<{ account_id: string }>(`SELECT account_id FROM wallet_deployment_jobs
          WHERE descriptor->>'deployerPublicKey'=$1 AND status='PENDING' AND next_attempt_at<=NOW()
          ORDER BY created_at,account_id LIMIT 1 FOR UPDATE SKIP LOCKED`, [this.publicKey]);
        owner = next.rows[0]?.account_id;
        if (!owner) return;
        await client.query('UPDATE wallet_deployment_sponsors SET account_id=$2,updated_at=NOW() WHERE public_key=$1', [this.publicKey, owner]);
      }
      const token = randomUUID();
      const result = await client.query<Row>(`UPDATE wallet_deployment_jobs SET lease_token=$2,lease_until=NOW()+INTERVAL '2 minutes'
        WHERE account_id=$1 AND status IN ('PENDING','SUBMITTED') AND descriptor->>'deployerPublicKey'=$3
        AND (lease_until IS NULL OR lease_until<=NOW()) AND next_attempt_at<=NOW() RETURNING *`, [owner, token, this.publicKey]);
      return result.rows[0] ? job(result.rows[0]) : undefined;
    });
  }
  async assertBinding(j: DeploymentJob): Promise<void> {
    requireThat(j.descriptor && j.leaseToken, 'DEPLOYMENT_PLAN_REQUIRED');
    validateDeploymentDescriptor(j.descriptor);
    const result = await this.pool.query(`SELECT d.account_id FROM wallet_deployment_jobs d JOIN wallet_credentials c
      ON c.account_id=d.account_id AND c.id=d.descriptor->>'credentialId'
      WHERE d.account_id=$1 AND d.lease_token=$2 AND d.lease_until>NOW() AND d.descriptor=$3::jsonb
      AND c.public_key=d.descriptor->>'credentialPublicKey'`, [j.owner, j.leaseToken, JSON.stringify(j.descriptor)]);
    requireThat(result.rowCount === 1, 'DEPLOYMENT_LEASE_OR_CREDENTIAL_CHANGED');
  }
  async checkpoint(j: DeploymentJob, p: PreparedDeployment): Promise<DeploymentJob> {
    requireThat(j.descriptor && j.leaseToken && /^[a-f0-9]{64}$/.test(p.transactionHash) && p.signedXdr.length > 0 && Number.isSafeInteger(p.expiresAt), 'INVALID_DEPLOYMENT_CHECKPOINT');
    const result = await this.pool.query<Row>(`UPDATE wallet_deployment_jobs SET status='SUBMITTED',signed_xdr=$3,transaction_hash=$4,expires_at=$5,contract_address=$6,updated_at=NOW(),failure_code=NULL
      WHERE account_id=$1 AND lease_token=$2 AND lease_until>NOW() AND status='PENDING' AND signed_xdr IS NULL AND descriptor=$7::jsonb RETURNING *`,
    [j.owner, j.leaseToken, p.signedXdr, p.transactionHash, p.expiresAt, j.descriptor.address, JSON.stringify(j.descriptor)]);
    requireThat(result.rowCount === 1, 'DEPLOYMENT_CHECKPOINT_NOT_COMMITTED');
    return job(result.rows[0]);
  }
  async settle(j: DeploymentJob, outcome: Exclude<DeploymentOutcome, { status: 'NOT_FOUND' }>): Promise<void> {
    requireThat(j.descriptor && j.prepared && j.leaseToken, 'DEPLOYMENT_SUBMISSION_REQUIRED');
    const confirmed = outcome.status === 'CONFIRMED';
    if (confirmed) requireThat(Number.isSafeInteger(outcome.ledger) && outcome.ledger > 0 && outcome.signerRuleId === 0, 'INVALID_DEPLOYMENT_BINDING_EVIDENCE');
    await transaction(this.pool, async client => {
      // Match claim's lock order: sponsor first, then job. Never invert it under concurrency.
      const locked = await client.query<{account_id:string|null}>('SELECT account_id FROM wallet_deployment_sponsors WHERE public_key=$1 FOR UPDATE', [this.publicKey]);
      requireThat(locked.rows[0]?.account_id === j.owner, 'DEPLOYMENT_SPONSOR_RESERVATION_CHANGED');
      const result = await client.query(`UPDATE wallet_deployment_jobs SET status=$3,confirmed_ledger=$4,signer_rule_id=$5,
        binding_verified_at=CASE WHEN $3='CONFIRMED' THEN NOW() ELSE NULL END, failure_code=$6,
        lease_token=NULL,lease_until=NULL,updated_at=NOW()
        WHERE account_id=$1 AND lease_token=$2 AND status='SUBMITTED' AND signed_xdr=$7 AND transaction_hash=$8`,
      [j.owner, j.leaseToken, confirmed ? 'CONFIRMED' : 'FAILED', confirmed ? outcome.ledger : null,
        confirmed ? outcome.signerRuleId : null, confirmed ? null : 'DEPLOYMENT_FAILED_ONCHAIN', j.prepared!.signedXdr, j.prepared!.transactionHash]);
      requireThat(result.rowCount === 1, 'DEPLOYMENT_LEASE_LOST');
      const slot = await client.query('UPDATE wallet_deployment_sponsors SET account_id=NULL,updated_at=NOW() WHERE public_key=$1 AND account_id=$2', [this.publicKey, j.owner]);
      requireThat(slot.rowCount === 1, 'DEPLOYMENT_SPONSOR_RESERVATION_CHANGED');
    });
  }
  async retry(j: DeploymentJob, code: string): Promise<void> {
    requireThat(/^[A-Z0-9_]{1,100}$/.test(code), 'INVALID_DEPLOYMENT_ERROR_CODE');
    await this.pool.query(`UPDATE wallet_deployment_jobs SET failure_code=$3,lease_token=NULL,lease_until=NULL,
      next_attempt_at=NOW()+INTERVAL '10 seconds',updated_at=NOW() WHERE account_id=$1 AND lease_token=$2`, [j.owner, j.leaseToken, code]);
    // Never free a sponsor merely on timeout or NOT_FOUND: its signed bytes may still land.
  }
}
