import type { FastifyInstance } from 'fastify';
import { db, getCredentials, emailForAccount, sessionAccount } from '../store.js';

type Job = { status: string; contract_address: string | null; transaction_hash: string | null; attempt_count: number; failure_code: string | null; updated_at: Date };
const projection = 'status,contract_address,transaction_hash,attempt_count,failure_code,updated_at';
function publicJob(job: Job | undefined) {
  if (!job) return { status: 'NOT_STARTED', deploymentEnabled: false, spendingEnabled: false, recoveryReady: false };
  return { status: job.status, address: job.contract_address, transactionHash: job.transaction_hash,
    attempts: job.attempt_count, failureCode: job.failure_code, updatedAt: job.updated_at,
    deploymentEnabled: false, spendingEnabled: false, recoveryReady: false };
}

/** User-facing reservation only. No HTTP endpoint can claim deployment success. */
export async function registerDeploymentRoutes(app: FastifyInstance) {
  async function owner(header: string | undefined) {
    return sessionAccount(header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  }
  app.get('/api/v1/smart-account/deployment', async (request, reply) => {
    const accountID = await owner(request.headers.authorization);
    if (!accountID) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    const { rows } = await db.query<Job>(`SELECT ${projection} FROM wallet_deployment_jobs WHERE account_id=$1`, [accountID]);
    return publicJob(rows[0]);
  });
  app.post('/api/v1/smart-account/deployment', async (request, reply) => {
    const accountID = await owner(request.headers.authorization);
    if (!accountID) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    const [identity, credentials] = await Promise.all([emailForAccount(accountID), getCredentials(accountID)]);
    if (!identity?.email_verified_at) return reply.code(409).send({ error: 'EMAIL_VERIFICATION_REQUIRED' });
    const target = credentials.length >= 2 ? 'PENDING' : 'AWAITING_PASSKEY';
    // Upsert is atomic and cannot downgrade an in-flight or active deployment.
    const { rows } = await db.query<Job>(`
      INSERT INTO wallet_deployment_jobs(account_id,status) VALUES($1,$2)
      ON CONFLICT(account_id) DO UPDATE SET
        status=CASE WHEN wallet_deployment_jobs.status='AWAITING_PASSKEY' AND EXCLUDED.status='PENDING'
          THEN 'PENDING' ELSE wallet_deployment_jobs.status END,
        updated_at=CASE WHEN wallet_deployment_jobs.status='AWAITING_PASSKEY' AND EXCLUDED.status='PENDING'
          THEN NOW() ELSE wallet_deployment_jobs.updated_at END
      RETURNING ${projection}`, [accountID, target]);
    reply.code(202);
    return { ...publicJob(rows[0]), nextAction: rows[0].status === 'AWAITING_PASSKEY'
      ? 'ENROLL_INDEPENDENT_BACKUP_PASSKEY' : rows[0].status === 'PENDING'
      ? 'AWAIT_VERIFIED_TESTNET_DEPLOYMENT_WORKER' : 'CHECK_DEPLOYMENT_STATUS' };
  });
}
