import { integrationConfig } from './integrations/routes.js';
import { invoiceWebhookConfig } from './invoices/webhook.js';
export const STELLAR_NETWORK = 'TESTNET' as const;
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';
export type ExchangeMailConfig = {
 tenantId: string; clientId: string; clientSecret: string;
 sender: string; senderName: string; invoiceFromEmail: string; invoiceFromName: string;
 graphBaseUrl: string; timeoutMs: number; connectTimeoutMs: number;
 saveToSentItems: boolean; fallbackToMail: boolean;
};
export function getExchangeMailConfig(env: NodeJS.ProcessEnv = process.env): ExchangeMailConfig {
 const tenantId = env.AZURE_MAIL_TENANT_ID ?? '';
 const clientId = env.AZURE_MAIL_CLIENT_ID ?? '';
 const clientSecret = env.AZURE_MAIL_CLIENT_SECRET ?? '';
 const sender = env.AZURE_MAIL_SENDER ?? env.EXCHANGE_MAIL_INVOICE_FROM_EMAIL ?? '';
 const senderName = env.EXCHANGE_MAIL_SENDER_NAME ?? 'Cherry Wallet';
 const invoiceFromEmail = env.EXCHANGE_MAIL_INVOICE_FROM_EMAIL ?? sender;
 const invoiceFromName = env.EXCHANGE_MAIL_INVOICE_FROM_NAME ?? senderName;
 const graphBaseUrl = env.EXCHANGE_MAIL_GRAPH_BASE_URL ?? 'https://graph.microsoft.com/v1.0';
 const timeout = Number(env.EXCHANGE_MAIL_TIMEOUT ?? '10');
 const connectTimeout = Number(env.EXCHANGE_MAIL_CONNECT_TIMEOUT ?? '5');
 const parseBool = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw Error('EXCHANGE_MAIL_BOOLEAN_INVALID');
 };
 const saveToSentItems = parseBool(env.EXCHANGE_MAIL_SAVE_TO_SENT_ITEMS, true);
 const fallbackToMail = parseBool(env.EXCHANGE_MAIL_FALLBACK_TO_MAIL, false);
 if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !/^[0-9a-f-]{36}$/i.test(clientId) || !clientSecret ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender) ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invoiceFromEmail) ||
  !Number.isFinite(timeout) || timeout < 1 || timeout > 60 ||
  !Number.isFinite(connectTimeout) || connectTimeout < 1 || connectTimeout > timeout ||
  graphBaseUrl !== 'https://graph.microsoft.com/v1.0' || fallbackToMail)
  throw Error('AZURE_MAIL_CONFIGURATION_INVALID');
 return {tenantId,clientId,clientSecret,sender,senderName,invoiceFromEmail,invoiceFromName,graphBaseUrl,
  timeoutMs:timeout*1000,connectTimeoutMs:connectTimeout*1000,saveToSentItems,fallbackToMail};
}
export function getConfig(env: NodeJS.ProcessEnv = process.env) {
 const origin = env.WALLET_ORIGIN ?? 'http://localhost:5173';
 const url = new URL(origin);
 if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('WALLET_ORIGIN must be HTTPS or localhost');
 if (url.pathname !== '/' || url.search || url.hash) throw new Error('WALLET_ORIGIN must be an origin only');
 const rpID = env.WEBAUTHN_RP_ID ?? url.hostname;
 if (rpID !== url.hostname && !url.hostname.endsWith('.' + rpID)) throw new Error('WEBAUTHN_RP_ID must match origin hostname or its parent domain');
 return { origin:url.origin, rpID, port:Number(env.PORT ?? '3001'), network:STELLAR_NETWORK, rpcUrl:TESTNET_RPC_URL, horizonUrl:TESTNET_HORIZON_URL, integrations: integrationConfig(env), invoiceWebhook:invoiceWebhookConfig(env), mapsBrowserKey:env.GOOGLE_MAPS_BROWSER_KEY, marketDemoKey:env.COINGECKO_DEMO_API_KEY };
}
