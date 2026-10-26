import type { WalletBackendClient } from '../indexing/wallet-backend.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PaymentError, publicAttempt, requireThat, type Intent } from './model.js';
import type { PasskeyApprovalService } from './passkey-approval.js';
import type { AuthenticationResponseJSON } from '@simplewebauthn/types';
import type { PaymentService } from './service.js';

const identifier = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' };
const amountSchema = { type: 'string', pattern: '^[1-9][0-9]{0,18}$' };
export const paymentSchemas = {
  assertion: { type: 'object', additionalProperties: false, required: ['requestID','response'], properties: {
    requestID: { type: 'string', minLength: 1, maxLength: 128 },
    response: { type: 'object', required: ['id','rawId','type','response','clientExtensionResults'], properties: {
      id: { type: 'string', maxLength: 1024 }, rawId: { type: 'string', maxLength: 1024 }, type: { const: 'public-key', type: 'string' },
      response: { type: 'object', required: ['authenticatorData','clientDataJSON','signature'], properties: { authenticatorData: { type: 'string', maxLength: 4096 }, clientDataJSON: { type: 'string', maxLength: 8192 }, signature: { type: 'string', maxLength: 2048 }, userHandle: { type: 'string', maxLength: 1024 } } },
      clientExtensionResults: { type: 'object' }, authenticatorAttachment: { type: 'string' }
    } }
  } },
  intent: { type: 'object', additionalProperties: false, required: ['network', 'destination', 'amountStroops', 'maxFeeStroops'], properties: {
    network: { const: 'TESTNET', type: 'string' }, destination: { type: 'string', minLength: 56, maxLength: 56 }, amountStroops: amountSchema, maxFeeStroops: amountSchema,
  } },
  approval: { type: 'object', additionalProperties: false, required: ['authXdr'], properties: { authXdr: { type: 'string', minLength: 1, maxLength: 16000, pattern: '^[A-Za-z0-9+/]+={0,2}$' } } },
  wallet: { type: 'object', additionalProperties: false, required: ['walletId'], properties: { walletId: identifier } },
  attempt: { type: 'object', additionalProperties: false, required: ['walletId', 'attemptId'], properties: { walletId: identifier, attemptId: identifier } },
  page: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string', maxLength: 512 } } },
};
export type PaymentDependencies = {
  service: PaymentService;
  indexer?: Pick<WalletBackendClient, 'account'>;
  // B1/B2 session integration. Never derive identity from body/accountID or an unverified header.
  authenticate(request: FastifyRequest): Promise<{ subject: string; sessionHash?: string } | null>;
  origin: string;
  approvals?: PasskeyApprovalService;
  // Only trusted B1/B2 code may return a supported funding route.
  receiveRoute?(walletId: string, owner: string): Promise<{ address: string; route: 'classic' | 'contract'; instructions: string } | undefined>;
};
export async function registerPaymentRoutes(app: FastifyInstance, dependencies?: PaymentDependencies) {
  await app.register(async scope => {
    const principals = new WeakMap<FastifyRequest, { subject: string; sessionHash?: string }>();
    scope.addHook('onRequest', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!dependencies) return reply.code(503).send({ error: 'PAYMENT_INTEGRATION_NOT_CONFIGURED' });
      if (request.method !== 'GET' && request.headers.origin !== dependencies.origin) return reply.code(403).send({ error: 'UNTRUSTED_ORIGIN' });
      const principal = await dependencies.authenticate(request);
      if (!principal?.subject) return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
      principals.set(request, principal);
    });
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof PaymentError) return reply.code(error.status).send({ error: error.code });
      if (error.validation) return reply.code(400).send({ error: 'INVALID_REQUEST' });
      return reply.code(503).send({ error: 'PAYMENT_SERVICE_UNAVAILABLE' });
    });
    const context = async (request: FastifyRequest) => {
      requireThat(dependencies && principals.has(request), 'AUTHENTICATION_REQUIRED', 401);
      const params = request.params as { walletId: string; attemptId?: string };
      const owner = principals.get(request)!.subject;
      const wallet = await dependencies.service.store.wallet(params.walletId, owner);
      return { service: dependencies.service, owner, wallet, id: params.attemptId! };
    };
    scope.get('/api/v1/wallets', { schema: { querystring: {type:'object',additionalProperties:false} } }, async request => {
      const wallets=await dependencies!.service.store.walletsForOwner(principals.get(request)!.subject);
      requireThat(wallets.length<=100,'WALLET_DISCOVERY_LIMIT');
      return {network:'TESTNET',items:wallets.map(wallet=>({id:wallet.id,address:wallet.address,network:'TESTNET'}))};
    });
    scope.get('/api/v1/wallets/:walletId', { schema: { params: paymentSchemas.wallet } }, async request => {
      const { wallet } = await context(request);
      const receive = await dependencies?.receiveRoute?.(wallet.id, principals.get(request)!.subject);
      if (receive) requireThat(receive.address === wallet.address && receive.route === 'contract' && wallet.address.startsWith('C') && typeof receive.instructions === 'string' && receive.instructions.length > 0, 'INVALID_RECEIVE_ROUTE');
      return { id: wallet.id, address: wallet.address, network: 'TESTNET', supportedDestinations: wallet.routes, approvalMode: dependencies?.approvals ? 'webauthn' : 'external', receive };
    });
    scope.post('/api/v1/wallets/:walletId/attempts', { schema: { params: paymentSchemas.wallet, body: paymentSchemas.intent } }, async (request, reply) => {
      const { service, owner, wallet } = await context(request);
      const key = request.headers['idempotency-key']; requireThat(typeof key === 'string', 'IDEMPOTENCY_KEY_REQUIRED', 400);
      reply.code(202); return publicAttempt(await service.create(owner, wallet.id, request.body as Intent, key));
    });
    scope.get('/api/v1/wallets/:walletId/attempts', { schema: { params: paymentSchemas.wallet, querystring: paymentSchemas.page } }, async request => {
      const { service, wallet } = await context(request); const page = await service.store.list(wallet.id, (request.query as { cursor?: string }).cursor);
      return { items: page.slice(0, 50).map(row => publicAttempt(row.attempt)), nextCursor: page.length > 50 ? page[49].cursor : undefined };
    });
    scope.get('/api/v1/wallets/:walletId/attempt-by-key/:key', { schema: { params: { type: 'object', required: ['walletId', 'key'], additionalProperties: false, properties: { walletId: identifier, key: identifier } } } }, async request => {
      const { service, wallet } = await context(request); const a = await service.store.byKey(wallet.id, (request.params as { key: string }).key);
      requireThat(a, 'ATTEMPT_NOT_FOUND', 404); return publicAttempt(a);
    });
    scope.get('/api/v1/wallets/:walletId/attempts/:attemptId', { schema: { params: paymentSchemas.attempt } }, async request => {
      const { service, owner, wallet, id } = await context(request); return publicAttempt(await service.get(owner, wallet.id, id));
    });
    scope.post('/api/v1/wallets/:walletId/attempts/:attemptId/approve', { schema: { params: paymentSchemas.attempt, body: paymentSchemas.approval } }, async (request, reply) => {
      // Contract WebAuthn verification intentionally omits RP/origin/counter checks.
      // Configured WebAuthn mode must always use our session-bound verification path.
      requireThat(!dependencies?.approvals,'EXTERNAL_APPROVAL_DISABLED',403);
      const { service, owner, wallet, id } = await context(request); reply.code(202);
      return publicAttempt(await service.approve(owner, wallet.id, id, (request.body as { authXdr: string }).authXdr));
    });
    scope.post('/api/v1/wallets/:walletId/attempts/:attemptId/approval/options', { schema: { params: paymentSchemas.attempt, body: { type: 'object', additionalProperties: false } } }, async request => {
      const { owner, wallet, id } = await context(request);
      const sessionHash = principals.get(request)!.sessionHash;
      requireThat(dependencies?.approvals && sessionHash, 'PASSKEY_APPROVAL_NOT_CONFIGURED',503);
      return dependencies.approvals.begin(owner,wallet.id,id,sessionHash);
    });
    scope.post('/api/v1/wallets/:walletId/attempts/:attemptId/approval/verify', { schema: { params: paymentSchemas.attempt, body: paymentSchemas.assertion } }, async (request,reply) => {
      const { owner, wallet, id } = await context(request);
      const sessionHash = principals.get(request)!.sessionHash;
      requireThat(dependencies?.approvals && sessionHash, 'PASSKEY_APPROVAL_NOT_CONFIGURED',503);
      const body=request.body as {requestID:string;response:AuthenticationResponseJSON};
      reply.code(202); return publicAttempt(await dependencies.approvals.finish(owner,wallet.id,id,sessionHash,body.requestID,body.response));
    });
    scope.post('/api/v1/wallets/:walletId/attempts/:attemptId/check', { schema: { params: paymentSchemas.attempt, body: { type: 'object', additionalProperties: false } } }, async request => {
      const { service, owner, wallet, id } = await context(request); const a = await service.get(owner, wallet.id, id);
      // HTTP status checks are read-only. The durable worker reconciles/broadcasts identical bytes.
      return publicAttempt(a);
    });
    scope.post('/api/v1/wallets/:walletId/attempts/:attemptId/cancel', { schema: { params: paymentSchemas.attempt, body: { type: 'object', additionalProperties: false } } }, async request => {
      const { service, owner, wallet, id } = await context(request); return publicAttempt(await service.cancel(owner, wallet.id, id));
    });
    scope.get('/api/v1/wallets/:walletId/indexed', { schema: { params: paymentSchemas.wallet, querystring: {type:'object',additionalProperties:false} } }, async request => {
      const { wallet } = await context(request);
      requireThat(dependencies?.indexer, 'INDEXER_NOT_CONFIGURED',503);
      const account = await dependencies.indexer.account(wallet.address);
      requireThat(account.address === wallet.address, 'INDEXER_ADDRESS_MISMATCH');
      return {network:'TESTNET',source:'wallet-backend',verified:false,observedAt:new Date().toISOString(),account};
    });
    scope.get('/api/v1/wallets/:walletId/balance', { schema: { params: paymentSchemas.wallet } }, async request => {
      const { service, wallet } = await context(request); return { network: 'TESTNET', address: wallet.address, snapshot: await service.store.balance(wallet.address) };
    });
    scope.get('/api/v1/wallets/:walletId/history', { schema: { params: paymentSchemas.wallet, querystring: paymentSchemas.page } }, async request => {
      const { service, wallet } = await context(request); const page = await service.store.history(wallet.address, (request.query as { cursor?: string }).cursor);
      return { network: 'TESTNET', items: page.slice(0, 50).map(row => ({ ...row.event, verified: true, receipt: `https://stellar.expert/explorer/testnet/tx/${row.event.transactionHash}` })), nextCursor: page.length > 50 ? page[49].cursor : undefined };
    });
  });
}

