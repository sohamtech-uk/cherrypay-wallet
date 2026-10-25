import type { FastifyInstance } from 'fastify';
import { TESTNET_V080 } from './kit-v080-preflight.js';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
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


  // The client generates and retains the Ed25519 secret. We bind only a
  // possession-proven public G-address to the authenticated profile.
  app.post('/api/v1/smart-account/classic/challenge', async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const accountID = await sessionAccount(token);
    if (!accountID) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    const body = request.body as { publicKey?: string };
    if (!body || typeof body.publicKey !== 'string' || !StrKey.isValidEd25519PublicKey(body.publicKey)) return reply.code(400).send({ error: 'INVALID_PUBLIC_KEY' });
    const nonce = randomBytes(32).toString('hex');
    const challenge = 'CHERRYPAY_TESTNET_CLASSIC_BIND_V1:' + accountID + ':' + body.publicKey + ':' + nonce;
    await db.query(`INSERT INTO wallet_classic_challenges(account_id,public_key,nonce,expires_at)
      VALUES($1,$2,$3,NOW()+INTERVAL '2 minutes')
      ON CONFLICT(account_id) DO UPDATE SET public_key=$2,nonce=$3,expires_at=NOW()+INTERVAL '2 minutes'`, [accountID,body.publicKey,nonce]);
    return { challenge };
  });

  app.post('/api/v1/smart-account/classic/bind', async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer /, '');
    const accountID = await sessionAccount(token);
    if (!accountID) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    const body = request.body as { publicKey?: string; signature?: string };
    if (!body || typeof body.publicKey !== 'string' || !StrKey.isValidEd25519PublicKey(body.publicKey) ||
      typeof body.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(body.signature)) return reply.code(400).send({ error: 'INVALID_BINDING_PROOF' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT public_key FROM wallet_classic_addresses WHERE account_id=$1 FOR UPDATE', [accountID]);
      if (existing.rows.length) { await client.query('ROLLBACK'); return reply.code(409).send({ error: 'CLASSIC_ADDRESS_ALREADY_BOUND' }); }
      const pending = await client.query('DELETE FROM wallet_classic_challenges WHERE account_id=$1 AND public_key=$2 AND expires_at>NOW() RETURNING nonce', [accountID,body.publicKey]);
      if (pending.rows.length !== 1) { await client.query('ROLLBACK'); return reply.code(400).send({ error: 'CHALLENGE_EXPIRED' }); }
      const message = 'CHERRYPAY_TESTNET_CLASSIC_BIND_V1:' + accountID + ':' + body.publicKey + ':' + pending.rows[0].nonce;
      const valid = Keypair.fromPublicKey(body.publicKey).verify(Buffer.from(message), Buffer.from(body.signature,'base64url'));
      if (!valid) { await client.query('ROLLBACK'); return reply.code(400).send({ error: 'INVALID_BINDING_PROOF' }); }
      await client.query('INSERT INTO wallet_classic_addresses(account_id,public_key,proof_nonce) VALUES($1,$2,$3)', [accountID,body.publicKey,pending.rows[0].nonce]);
      await client.query('COMMIT');
      return { network: 'TESTNET', publicKey: body.publicKey, funded: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });

  app.get('/api/v1/smart-account/classic', async (request, reply) => {
    const accountID = await sessionAccount(request.headers.authorization?.replace(/^Bearer /, ''));
    if (!accountID) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    const {rows} = await db.query('SELECT public_key FROM wallet_classic_addresses WHERE account_id=$1', [accountID]);
    return { network: 'TESTNET', publicKey: rows[0]?.public_key ?? null };
  });

  // Both address types are independently visible; a reserved C-address is not deployed.
  app.get('/api/v1/smart-account/addresses', async (request, reply) => {
    const accountID = await sessionAccount(request.headers.authorization?.replace(/^Bearer /, ''));
    if (!accountID) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    const [classic, smart] = await Promise.all([
      db.query<{public_key:string}>('SELECT public_key FROM wallet_classic_addresses WHERE account_id=$1', [accountID]),
      db.query<{contract_address:string|null;status:string}>('SELECT contract_address,status FROM wallet_deployment_jobs WHERE account_id=$1', [accountID])
    ]);
    reply.header('Cache-Control', 'no-store');
    return { network: 'TESTNET', wallets: [
      { type: 'G', address: classic.rows[0]?.public_key ?? null, status: classic.rows.length ? 'BOUND' : 'NOT_CREATED', paymentsEnabled: false },
      { type: 'C', address: smart.rows[0]?.contract_address ?? null, status: smart.rows[0]?.status ?? 'NOT_STARTED', paymentsEnabled: false }
    ] };
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
