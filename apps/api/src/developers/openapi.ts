import { paymentOpenApi } from '../payments/openapi.js';

/**
 * The public, read-only wallet contract reuses the generated payments, invoice
 * and payroll spec. Authentication, deployment and optional integrations are
 * described here against the registered application routes.
 *
 * This document contains API SHAPES only: no tokens, keys, wallet records or
 * privileged configuration. It does not enable a disabled payment feature.
 */
const errorResponse = { description: 'Error response', content: { 'application/json': { schema: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } } } } };
const jsonResponse = { description: 'Result (check the returned state; it is not proof of on-chain settlement)', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } };
const plain = { type: 'object', additionalProperties: false };
const text = { type: 'string' };
const email = { type: 'string', format: 'email', maxLength: 254 };
const body = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });
const envelope = (properties: object, required: string[]) => body({ type: 'object', additionalProperties: false, required, properties });
const bearer = [{ WalletSession: [] }];
const pathAddress = [{ name: 'address', in: 'path', required: true, schema: { type: 'string', minLength: 56, maxLength: 56 } }];
const query = (name: string, description: string) => ({ name, in: 'query', required: true, description, schema: text });
function read(summary: string, description: string, authenticated = false, parameters: object[] = []) {
  return { summary, description, security: authenticated ? bearer : [], ...(parameters.length ? { parameters } : {}),
    responses: { '200': jsonResponse, '400': errorResponse, '401': errorResponse, '503': errorResponse } };
}
function mutation(summary: string, description: string, request: object, authenticated = false, accepted = false) {
  return { summary, description: description + ' Mutations require the configured same-origin Origin header.', security: authenticated ? bearer : [],
    requestBody: request, responses: { [accepted ? '202' : '200']: jsonResponse, '400': errorResponse, '401': errorResponse,
      '403': errorResponse, '409': errorResponse, '429': errorResponse, '503': errorResponse } };
}
const identity = {
  '/health': { get: read('Check API process liveness', 'Public liveness only, including current deployment/payment capability booleans. A healthy process is not proof of on-chain settlement.') },
  '/ready': { get: read('Check API database readiness', 'Returns 200 when the database is reachable, or 503 on readiness failure. Not a blockchain readiness guarantee.') },
  '/api/v1/openapi.json': { get: read('Fetch live OpenAPI 3.1 documentation', 'The public read-only developer API contract. Contains endpoint descriptions and schemas, not account data or secrets.') },
  '/api/v1/network': { get: read('Check selected Stellar network', 'Returns configured Testnet RPC/Horizon endpoints and whether deployment is available; no transfer authority.') },
  '/api/v1/passkeys/onboarding/options': {
    post: mutation('Begin email-linked passkey onboarding', 'Returns a registration or authentication WebAuthn ceremony for the supplied email; email is an account identifier, not mailbox-ownership proof.', envelope({ email }, ['email']))
  },
  '/api/v1/passkeys/registration/options': {
    post: mutation('Begin WebAuthn passkey enrollment', 'For a new account supply email. For an authenticated account, supply accountID with its bearer session. Registering another login passkey does not add an on-chain backup signer.', body({ type: 'object', additionalProperties: false, properties: { email, accountID: text } }))
  },
  '/api/v1/passkeys/registration/verify': {
    post: mutation('Verify WebAuthn passkey registration', 'Completes a one-time registration challenge and returns session information. The browser must never log the bearer token.', envelope({ accountID: text, requestID: text, response: { type: 'object' } }, ['accountID','requestID','response']))
  },
  '/api/v1/passkeys/authentication/options': {
    post: mutation('Begin returning-account passkey sign-in', 'Authentication accepts email or an existing accountID for compatibility; the wallet UI is email-first.', body({ type: 'object', additionalProperties: false, properties: { email, accountID: text } }))
  },
  '/api/v1/passkeys/authentication/verify': {
    post: mutation('Verify returning-account passkey assertion', 'Completes the requested WebAuthn challenge and returns an expiring owner session.', envelope({ accountID: text, requestID: text, response: { type: 'object' } }, ['accountID','requestID','response']))
  },
  '/api/v1/wallet/me': {
    get: read('Read authenticated wallet identity', 'Returns the session account ID, email, emailVerified boolean, credential count, and deployment availability. Login with an email does not itself verify ownership of that mailbox.', true)
  },
  '/api/v1/session/logout': {
    post: { ...mutation('Revoke the current session', 'Invalidates the supplied bearer token. An empty or missing token does not revoke another user\'s session.', body(plain), true),
      responses: { '204': { description: 'Session revoked or no session was supplied' }, '403': errorResponse } }
  }
};
const recipientDirectory = {
  '/api/v1/wallet/email-verification/request': {
    post: mutation('Send mailbox verification code', 'Authenticated owner only. Uses configured Exchange Online; code expires after 15 minutes.', body(plain), true)
  },
  '/api/v1/wallet/email-verification/confirm': {
    post: mutation('Confirm mailbox ownership', 'The eight digit code is rate limited and has a maximum of five guesses. Email verification is not legal identity verification.', envelope({ code: { type:'string' } }, ['code']), true)
  },
  '/api/v1/wallet/email-directory': {
    post: mutation('Opt in or out of email payments', 'Opt-in requires mailbox verification and confirmed on-chain wallet binding.', envelope({ enabled: { type:'boolean' } }, ['enabled']), true)
  },
  '/api/v1/recipients/resolve': {
    get: read('Resolve an opted-in recipient email', 'Exact-match authenticated Testnet C-address lookup only. Unverified, private and missing accounts are indistinguishable. No legal identity verification.', true, [{ name:'email', in:'query',required:true,schema:{ type:'string',format:'email' } }])
  }
};
const deployment = {
  '/api/v1/smart-account/capabilities': { get: read('Read smart-account capability gates', 'Testnet contract and verifier metadata. capabilityScope is runtime: spendingEnabled reports the same payment service availability as /health.walletPaymentsEnabled. walletVerificationRequired remains true; individual wallet ownership, on-chain signer and payment authorization checks still apply. These flags are not proof of a completed payment or independent recovery.') },
  '/api/v1/smart-account/relayer': { get: read('Read public Testnet relayer information', 'Returns non-secret relayer status and public key when configured.') },
  '/api/v1/smart-account/deployment': {
    get: read('Check authenticated smart-wallet deployment', 'Owner-scoped deployment status, verified contract address and signer binding when confirmed.', true),
    post: mutation('Queue or resume wallet deployment', 'Idempotently requests or resumes deployment for the authenticated owner. A 202 is not on-chain confirmation.', body(plain), true, true)
  },
  '/api/v1/smart-account/funding': {
    post: mutation('Request one-time Testnet XLM funding', 'Only configured and verified wallets qualify. A 202 means the funding request was queued, NOT confirmed. Check deployment funding status.', body(plain), true, true)
  },
  '/api/v1/smart-account/{address}/status': {
    get: read('Read owner-scoped contract verification status', 'The provided C-address must match the authenticated owner when deployment is enabled. This does not establish backup recovery.', true, pathAddress)
  }
};
const integrations = {
  '/api/v1/aurora/capabilities': { get: read('Check optional Aurora route availability', 'Aurora Base USDC to Stellar USDC is MAINNET-only when configured; it never funds the Stellar Testnet wallet.') },
  '/api/v1/aurora/quotes': {
    post: mutation('Request conditional Aurora MAINNET quote', 'Available only when a separate MAINNET integration is deliberately enabled. Requires real Base funds and is NOT a Testnet XLM wallet API.', envelope({ recipient: text, refundTo: text, amount: text }, ['recipient','refundTo','amount']))
  },
  '/api/v1/aurora/status': {
    get: read('Read existing Aurora swap status', 'Requires a provider-configured status service. A provider status is not independent Stellar settlement proof.', false, [query('depositAddress','Original Base deposit address to check')])
  },
  '/api/v1/intelligence/recipient': {
    get: read('Check Stellar recipient coverage', 'Stellar Nansen risk intelligence is NOT supported. Validating a checksum is not a risk assessment or payee verification.', false,
      [query('address','Stellar G-address or C-address'), { name: 'network', in: 'query', required: true, schema: { type: 'string', enum: ['TESTNET','MAINNET'] } }])
  }
};
export const walletOpenApi = {
  ...paymentOpenApi,
  info: { ...paymentOpenApi.info,
    title: 'Cherry Pay Wallet API — Developer Reference',
    description: 'Same-origin API reference for Stellar Testnet smart-wallet accounts, WebAuthn, native XLM payments, invoice checkout, payroll and optional integrations. Available endpoints do not imply feature activation. API responses require verification before marking transactions settled; no real GBP or mainnet XLM transfer support is implied.' },
  servers: [{ url: '/', description: 'Same origin as Cherry Wallet; use /api/v1 for application endpoints.' }],
  paths: { ...paymentOpenApi.paths, ...identity, ...recipientDirectory, ...deployment, ...integrations }
};
