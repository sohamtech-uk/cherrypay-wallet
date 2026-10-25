import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerSmartAccountRoutes } from './routes.js';
import { TESTNET_V080 } from './kit-v080-preflight.js';

describe('XLM-only smart-account capabilities', () => {
  it('advertises approved v0.8.0 code and never claims unverified deployment or recovery', async () => {
    const app = Fastify();
    await registerSmartAccountRoutes(app);
    try {
      const response = await app.inject({ url: '/api/v1/smart-account/capabilities' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({
        network: 'TESTNET',
        candidateVersion: '0.8.0',
        accountWasmHash: TESTNET_V080.accountWasmHash,
        webauthnVerifierAddress: TESTNET_V080.verifierAddress,
        webauthnVerifierWasmHash: TESTNET_V080.verifierWasmHash,
        asset: 'XLM',
        supportedAssets: ['XLM'],
        supportsSwaps: false,
        supportsFiatConversion: false,
        deploymentEnabled: false,
        spendingEnabled: false,
        recoveryEnabled: false,
      });
    } finally { await app.close(); }
  });
});
