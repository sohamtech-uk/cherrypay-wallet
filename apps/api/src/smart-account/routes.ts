import type { FastifyInstance } from 'fastify';
import { TESTNET_V080 } from './kit-v080-preflight.js';
import { StrKey } from '@stellar/stellar-sdk';
import { sessionAccount, db } from '../store.js';
import { createTestnetRpc } from './deployment-evidence.js';
import { TESTNET_PASSPHRASE } from '../config.js';
import { testnetRelayer } from './relayer.js';

/**
 * Read-only integration boundary until a contract implementation and
 * deployment are independently verified. No contract deployment or spending
 * authorization is exposed by this module.
 */
export async function registerSmartAccountRoutes(app: FastifyInstance) {

  // Reserve exactly one deployment per authenticated account. The reservation
  // is not proof of deployment, ownership or recovery.
  app.post('/api/v1/smart-account/deployment', async (request, reply) => {
    const bearer = request.headers.authorization;
    const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined;
    const accountID = await sessionAccount(token);
    if (!accountID) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    const { rows } = await db.query<{ status: string; contract_address: string | null; transaction_hash: string | null }>(
      `INSERT INTO wallet_deployment_jobs(account_id) VALUES($1)
       ON CONFLICT (account_id) DO UPDATE SET updated_at=wallet_deployment_jobs.updated_at
       RETURNING status, contract_address, transaction_hash`, [accountID]);
    reply.code(202);
    return { status: rows[0].status, address: rows[0].contract_address, transactionHash: rows[0].transaction_hash, deploymentEnabled: false, nextAction: 'PASSKEY_CONTROLLED_DEPLOYMENT_NOT_YET_CONFIGURED' };
  });

  app.get('/api/v1/smart-account/deployment', async (request, reply) => {
    const bearer = request.headers.authorization;
    const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined;
    const accountID = await sessionAccount(token);
    if (!accountID) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    const { rows } = await db.query<{ status: string; contract_address: string | null; transaction_hash: string | null }>(
      'SELECT status, contract_address, transaction_hash FROM wallet_deployment_jobs WHERE account_id=$1', [accountID]);
    return rows.length ? { status: rows[0].status, address: rows[0].contract_address, transactionHash: rows[0].transaction_hash, deploymentEnabled: false } : { status: 'NOT_STARTED', deploymentEnabled: false };
  });


  app.get('/api/v1/smart-account/relayer', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const relayer = testnetRelayer();
    return { network: 'TESTNET', configured: relayer.configured, publicKey: relayer.configured ? relayer.publicKey : null, deploymentEnabled: false };
  });

  app.get('/api/v1/smart-account/capabilities', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      network: 'TESTNET',
      contractSelected: true,
      candidate: 'smart-account-kit',
      candidateVersion: '0.8.0',
      requiredStellarSdk: '16.3.x',
      accountWasmHash: TESTNET_V080.accountWasmHash,
      webauthnVerifierAddress: TESTNET_V080.verifierAddress,
      webauthnVerifierWasmHash: TESTNET_V080.verifierWasmHash,
      asset: 'XLM',
      supportedAssets: ['XLM'],
      supportsSwaps: false,
      supportsFiatConversion: false,
      securityStatus: 'PINNED_V080_ONCHAIN_ATTESTATION_REQUIRED',
      deploymentEnabled: false,
      spendingEnabled: false,
      recoveryEnabled: false,
      reason: 'WALLET_DEPLOYMENT_AND_INDEPENDENT_RECOVERY_NOT_VERIFIED',
    };
  });

  app.get('/api/v1/smart-account/:address/status', {
    schema: {
      params: {
        type: 'object',
        required: ['address'],
        additionalProperties: false,
        properties: { address: { type: 'string', minLength: 56, maxLength: 56 } },
      },
    },
  }, async (request, reply) => {
    const bearer = request.headers.authorization;
    const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : undefined;
    if (!await sessionAccount(token)) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    const { address } = request.params as { address: string };
    if (!StrKey.isValidContract(address)) return reply.code(400).send({ error: 'INVALID_CONTRACT_ADDRESS' });
    try {
      const network = await createTestnetRpc().getNetwork();
      if (network.passphrase !== TESTNET_PASSPHRASE) return reply.code(503).send({ error: 'RPC_NETWORK_MISMATCH' });
      // Never assert ownership, deployment, or recovery without on-chain proof.
      return { address, network: 'TESTNET', verified: false, recoveryReady: false, spendingEnabled: false };
    } catch {
      return reply.code(503).send({ error: 'STELLAR_RPC_UNAVAILABLE' });
    }
  });
}
