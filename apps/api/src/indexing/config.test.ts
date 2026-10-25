import { expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { configuredIndexer } from './config.js';
it('requires explicit Testnet configuration and a separate request signing key',()=>{
  expect(configuredIndexer({})).toBeUndefined();
  expect(()=>configuredIndexer({WALLET_INDEXER_ENABLED:'yes'})).toThrow('INVALID_INDEXER_ENABLE_FLAG');
  const env={WALLET_INDEXER_ENABLED:'true',WALLET_INDEXER_NETWORK:'TESTNET',WALLET_INDEXER_URL:'http://localhost:8001/graphql/query',WALLET_INDEXER_SIGNING_SECRET:Keypair.random().secret()};
  expect(configuredIndexer(env)).toBeDefined();
  expect(()=>configuredIndexer({...env,WALLET_INDEXER_NETWORK:'MAINNET'})).toThrow('INDEXER_TESTNET_REQUIRED');
  expect(()=>configuredIndexer({...env,STELLAR_RELAYER_SECRET:env.WALLET_INDEXER_SIGNING_SECRET})).toThrow('INDEXER_REQUIRES_SEPARATE_KEY');
});
