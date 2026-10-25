import { integrationConfig } from './integrations/routes.js';
export const STELLAR_NETWORK = 'TESTNET' as const;
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';
export function getConfig(env: NodeJS.ProcessEnv = process.env) {
 const origin = env.WALLET_ORIGIN ?? 'http://localhost:5173';
 const url = new URL(origin);
 if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('WALLET_ORIGIN must be HTTPS or localhost');
 if (url.pathname !== '/' || url.search || url.hash) throw new Error('WALLET_ORIGIN must be an origin only');
 const rpID = env.WEBAUTHN_RP_ID ?? url.hostname;
 if (rpID !== url.hostname && !url.hostname.endsWith('.' + rpID)) throw new Error('WEBAUTHN_RP_ID must match origin hostname or its parent domain');
 return { origin:url.origin, rpID, port:Number(env.PORT ?? '3001'), network:STELLAR_NETWORK, rpcUrl:TESTNET_RPC_URL, horizonUrl:TESTNET_HORIZON_URL, integrations: integrationConfig(env) };
}
