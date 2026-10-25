import type { FastifyInstance } from 'fastify';
import { TESTNET_V080 } from './kit-v080-preflight.js';
import { StrKey } from '@stellar/stellar-sdk';
import { sessionAccount, db, getCredentials } from '../store.js';
import { createTestnetRpc } from './deployment-evidence.js';
import { TESTNET_PASSPHRASE } from '../config.js';
import { testnetRelayer } from './relayer.js';
import { PaymentError } from '../payments/model.js';
import type { AutomaticDeploymentService } from './automatic-deployment.js';

/** Deployment is opt-in; payment authority and independent recovery remain separate. */
export async function registerSmartAccountRoutes(app: FastifyInstance, options: {
  deployments?: AutomaticDeploymentService; origin?: string;
} = {}) {
  const emptyBody = { type: 'object', additionalProperties: false };
  app.post('/api/v1/smart-account/deployment', { schema: { body: emptyBody } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (options.origin && request.headers.origin !== options.origin) return reply.code(403).send({ error: 'UNTRUSTED_ORIGIN' });
    try {
      const bearer = request.headers.authorization;
      const accountID = await sessionAccount(bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined);
      if (!accountID) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
      // No caller-supplied credential, owner, address, constructor or signed envelope.
      if (options.deployments) return reply.code(202).send(await options.deployments.queue(accountID));
      const credentials = await getCredentials(accountID);
      if (credentials.length < 2) {
        await db.query(`INSERT INTO wallet_deployment_jobs(account_id,status) VALUES($1,'AWAITING_PASSKEY')
          ON CONFLICT (account_id) DO UPDATE SET status=CASE
            WHEN wallet_deployment_jobs.status IN ('PENDING','AWAITING_PASSKEY') THEN 'AWAITING_PASSKEY'
            ELSE wallet_deployment_jobs.status END,updated_at=NOW()`, [accountID]);
        return reply.code(202).send({ status: 'AWAITING_PASSKEY', deploymentEnabled: false, nextAction: 'ENROLL_INDEPENDENT_BACKUP_PASSKEY' });
      }
      const { rows } = await db.query<{ status: string; contract_address: string | null; transaction_hash: string | null }>(
        `INSERT INTO wallet_deployment_jobs(account_id) VALUES($1)
         ON CONFLICT (account_id) DO UPDATE SET status=CASE
           WHEN wallet_deployment_jobs.status='AWAITING_PASSKEY' THEN 'PENDING'
           ELSE wallet_deployment_jobs.status END,updated_at=NOW()
         RETURNING status, contract_address, transaction_hash`, [accountID]);
      return reply.code(202).send({ status: rows[0].status, address: rows[0].contract_address, transactionHash: rows[0].transaction_hash, deploymentEnabled: false, nextAction: 'AWAITING_VERIFIED_TESTNET_DEPLOYMENT_WORKER' });
    } catch (error) {
      if (error instanceof PaymentError) return reply.code(error.status).send({ error: error.code });
      return reply.code(503).send({ error: 'DEPLOYMENT_SERVICE_UNAVAILABLE' });
    }
  });
  app.get('/api/v1/smart-account/deployment', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const bearer = request.headers.authorization;
      const accountID = await sessionAccount(bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined);
      if (!accountID) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
      if (options.deployments) return await options.deployments.status(accountID);
      const { rows } = await db.query<{ status: string; contract_address: string | null; transaction_hash: string | null }>(
        'SELECT status, contract_address, transaction_hash FROM wallet_deployment_jobs WHERE account_id=$1', [accountID]);
      return rows.length ? { status: rows[0].status, address: rows[0].contract_address, transactionHash: rows[0].transaction_hash, deploymentEnabled: false } : { status: 'NOT_STARTED', deploymentEnabled: false };
    } catch { return reply.code(503).send({ error: 'DEPLOYMENT_SERVICE_UNAVAILABLE' }); }
  });
  app.get('/api/v1/smart-account/relayer', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const relayer = testnetRelayer();
      return { network: 'TESTNET', configured: relayer.configured, publicKey: relayer.configured ? relayer.publicKey : null, deploymentEnabled: !!options.deployments };
    } catch { return reply.code(503).send({ error: 'RELAYER_CONFIGURATION_UNAVAILABLE' }); }
  });
  app.get('/api/v1/smart-account/capabilities', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      network: 'TESTNET', contractSelected: true, candidate: 'smart-account-kit', candidateVersion: '0.8.0', requiredStellarSdk: '16.3.x',
      accountWasmHash: TESTNET_V080.accountWasmHash,
      webauthnVerifierAddress: TESTNET_V080.verifierAddress, webauthnVerifierWasmHash: TESTNET_V080.verifierWasmHash,
      asset: 'XLM', supportedAssets: ['XLM'], supportsSwaps: false, supportsFiatConversion: false,
      securityStatus: 'PINNED_V080_ONCHAIN_ATTESTATION_REQUIRED',
      deploymentEnabled: !!options.deployments, spendingEnabled: false, recoveryEnabled: false,
      reason: options.deployments ? 'PRIMARY_DEPLOYMENT_ENABLED_BACKUP_RECOVERY_REQUIRED' : 'WALLET_DEPLOYMENT_AND_INDEPENDENT_RECOVERY_NOT_VERIFIED',
    };
  });
  app.get('/api/v1/smart-account/:address/status', {
    schema: { params: { type: 'object', required: ['address'], additionalProperties: false, properties: { address: { type: 'string', minLength: 56, maxLength: 56 } } } },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const bearer = request.headers.authorization;
      const owner = await sessionAccount(bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined);
      if (!owner) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
      const { address } = request.params as { address: string };
      if (!StrKey.isValidContract(address)) return reply.code(400).send({ error: 'INVALID_CONTRACT_ADDRESS' });
      if (options.deployments) {
        const status = await options.deployments.status(owner);
        if (status.address !== address) return reply.code(404).send({ error: 'DEPLOYED_WALLET_NOT_FOUND' });
        return { ...status, verified: status.onChainSignerBound };
      }
      const network = await createTestnetRpc().getNetwork();
      if (network.passphrase !== TESTNET_PASSPHRASE) return reply.code(503).send({ error: 'RPC_NETWORK_MISMATCH' });
      return { address, network: 'TESTNET', verified: false, recoveryReady: false, spendingEnabled: false };
    } catch { return reply.code(503).send({ error: 'STELLAR_RPC_UNAVAILABLE' }); }
  });
}
