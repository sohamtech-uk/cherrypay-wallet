import { Keypair, rpc } from '@stellar/stellar-sdk';
import { TESTNET_PASSPHRASE, TESTNET_RPC_URL } from '../config.js';

/** Testnet-only relayer identity. Never expose the secret in API responses. */
export function testnetRelayer(env: NodeJS.ProcessEnv = process.env) {
  const secret = env.STELLAR_RELAYER_SECRET;
  if (!secret) return { configured: false as const };
  const keypair = Keypair.fromSecret(secret);
  return { configured: true as const, publicKey: keypair.publicKey() };
}

/** Refuse all submission if the RPC endpoint is not Stellar Testnet. */
export async function assertTestnetRelayerNetwork(server: Pick<rpc.Server, 'getNetwork'> = new rpc.Server(TESTNET_RPC_URL, { timeout: 20 })) {
  const network = await server.getNetwork();
  if (network.passphrase !== TESTNET_PASSPHRASE) throw new Error('RELAYER_TESTNET_REQUIRED');
  return network.passphrase;
}
