import { Keypair } from '@stellar/stellar-sdk';
import { requireThat } from '../payments/model.js';
import { WalletBackendClient } from './wallet-backend.js';

/** Operator-pinned Testnet indexer. Configuration is not chain evidence. */
export function configuredIndexer(env: NodeJS.ProcessEnv = process.env) {
  requireThat(env.WALLET_INDEXER_ENABLED === undefined || ['true','false'].includes(env.WALLET_INDEXER_ENABLED), 'INVALID_INDEXER_ENABLE_FLAG');
  if (env.WALLET_INDEXER_ENABLED !== 'true') return;
  requireThat(env.WALLET_INDEXER_NETWORK === 'TESTNET', 'INDEXER_TESTNET_REQUIRED');
  requireThat(env.WALLET_INDEXER_URL && env.WALLET_INDEXER_SIGNING_SECRET, 'INDEXER_CONFIGURATION_REQUIRED');
  let signer: Keypair;
  try { signer = Keypair.fromSecret(env.WALLET_INDEXER_SIGNING_SECRET); }
  catch { throw Error('INVALID_INDEXER_SIGNING_SECRET'); }
  for (const secret of [env.STELLAR_RELAYER_SECRET, env.STELLAR_DEPLOYER_SECRET, env.STELLAR_TESTNET_FAUCET_SECRET]) {
    requireThat(!secret || secret !== env.WALLET_INDEXER_SIGNING_SECRET, 'INDEXER_REQUIRES_SEPARATE_KEY');
  }
  return new WalletBackendClient(env.WALLET_INDEXER_URL, fetch, signer);
}
