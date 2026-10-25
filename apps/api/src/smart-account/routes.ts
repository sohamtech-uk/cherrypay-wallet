import type { FastifyInstance } from 'fastify';
import { SMART_ACCOUNT_KIT } from './kit-manifest.js';
import { StrKey } from '@stellar/stellar-sdk';
import { sessionAccount } from '../store.js';
import { createTestnetRpc } from './deployment-evidence.js';
import { TESTNET_PASSPHRASE } from '../config.js';

/**
 * Read-only integration boundary until a contract implementation and
 * deployment are independently verified. No contract deployment or spending
 * authorization is exposed by this module.
 */
export async function registerSmartAccountRoutes(app: FastifyInstance) {
  app.get('/api/v1/smart-account/capabilities', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
      network: 'TESTNET',
      contractSelected: false,
      candidate: SMART_ACCOUNT_KIT.name,
      candidateVersion: SMART_ACCOUNT_KIT.version,
      requiredStellarSdk: SMART_ACCOUNT_KIT.requiredStellarSdk,
      accountWasmHash: SMART_ACCOUNT_KIT.accountWasmHash,
      webauthnVerifierAddress: SMART_ACCOUNT_KIT.webauthnVerifierAddress,
      securityStatus: SMART_ACCOUNT_KIT.securityStatus,
      deploymentEnabled: false,
      spendingEnabled: false,
      recoveryEnabled: false,
      reason: 'NO_APPROVED_ACCOUNT_WASM_OR_VERIFIED_CONTRACT_ADAPTER',
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
