import { paymentSchemas } from './routes.js';
const string = { type: 'string' };
const stroops = { type: 'string', pattern: '^[0-9]+$' };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const attempt = { type: 'object', required: ['id', 'walletId', 'network', 'from', 'destination', 'amountStroops', 'maxFeeStroops', 'status', 'createdAt', 'verified', 'feePayer'], properties: {
  id: string, walletId: string, network: { const: 'TESTNET' }, from: string, destination: string, amountStroops: stroops, maxFeeStroops: stroops,
  status: { enum: ['preparing', 'awaiting_approval', 'authorizing', 'ready', 'pending', 'unknown', 'confirmed', 'failed', 'rejected'] },
  createdAt: { type: 'string', format: 'date-time' }, verified: { type: 'boolean' }, feePayer: { const: 'sponsor' }, feeStroops: { ...stroops, description: 'Maximum authorized sponsored fee; not an exact charged fee.' },
  transactionHash: hash, eventId: string, failureCode: string, receipt: { type: 'string', format: 'uri' },
  approval: { type: 'object', required: ['authXdr', 'expirationLedger', 'expiresAt'], properties: { authXdr: { type: 'string', description: 'Unsigned Soroban authorization entry. The B1/B2 contract signer fills only its signature.' }, expirationLedger: { type: 'integer' }, expiresAt: { type: 'string', format: 'date-time' } } },
} };
function operation(summary: string, schema: object, body?: object, additionalParameters: object[] = []) {
  return { summary, security: [{ WalletSession: [] }], parameters: additionalParameters,
    ...(body ? { requestBody: { required: true, content: json(body) } } : {}),
    responses: { [summary.startsWith('Create') || summary.startsWith('Approve') ? '202' : '200']: { description: 'Persisted result; pending is not confirmation.', content: json(schema) },
      '400': { description: 'Invalid request', content: json(ref('Error')) }, '401': { description: 'No verified session', content: json(ref('Error')) },
      '403': { description: 'Untrusted mutation origin', content: json(ref('Error')) }, '404': { description: 'No owned resource', content: json(ref('Error')) },
      '409': { description: 'Conflicting intent, unresolved payment or state transition', content: json(ref('Error')) }, '503': { description: 'Integration/RPC unavailable', content: json(ref('Error')) } },
  };
}
const walletParameter = { name: 'walletId', in: 'path', required: true, schema: { type: 'string' } };
const attemptParameter = { name: 'attemptId', in: 'path', required: true, schema: { type: 'string' } };
const cursorParameter = { name: 'cursor', in: 'query', schema: { type: 'string', maxLength: 512 }, description: 'Opaque nextCursor from the previous page.' };
const base = '/api/v1/wallets/{walletId}';
export const paymentOpenApi = {
  openapi: '3.1.0', info: { title: 'Cherry Pay Wallet Testnet Payment API', version: '0.1.0', description: 'B3–B7 backend contract. Default server is disabled until verified B1/B2 session, contract and recovery adapters are composed. The P0 authentication adapter supplies a verified bearer session. No session is issued by this module.' },
  components: { securitySchemes: { WalletSession: { type: 'http', scheme: 'bearer', description: 'Verified owner session supplied by the B1/B2 authentication adapter; never an account ID.' } }, schemas: {
    Intent: paymentSchemas.intent, Approval: paymentSchemas.approval, PasskeyAssertion: paymentSchemas.assertion, Attempt: attempt, Error: { type: 'object', required: ['error'], properties: { error: string } },
    Wallet: { type: 'object', required: ['id', 'address', 'network', 'supportedDestinations'], properties: { id: string, address: string, network: { const: 'TESTNET' }, approvalMode: { enum: ['webauthn','external'] }, receive: { type: 'object', required: ['address','route','instructions'], properties: { address: string, route: { const: 'contract' }, instructions: string } }, supportedDestinations: { type: 'array', items: { enum: ['classic', 'contract'] } } } },
    AttemptPage: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: ref('Attempt') }, nextCursor: string } },
    Transfer: { type: 'object', required: ['id', 'transactionHash', 'ledger', 'operationIndex', 'eventIndex', 'from', 'to', 'amountStroops', 'closedAt', 'verified', 'receipt'], properties: { id: string, transactionHash: hash, ledger: { type: 'integer' }, operationIndex: { type: 'integer' }, eventIndex: { type: 'integer' }, from: string, to: string, amountStroops: stroops, closedAt: { type: 'integer', description: 'Unix milliseconds' }, verified: { const: true }, receipt: { type: 'string', format: 'uri' } } },
    HistoryPage: { type: 'object', required: ['network', 'items'], properties: { network: { const: 'TESTNET' }, items: { type: 'array', items: ref('Transfer') }, nextCursor: string } },
    Balance: { type: 'object', required: ['network', 'address', 'snapshot'], properties: { network: { const: 'TESTNET' }, address: string, snapshot: { oneOf: [{ type: 'null' }, { type: 'object', required: ['amountStroops', 'ledger', 'updatedAt'], properties: { amountStroops: stroops, ledger: { type: 'integer' }, updatedAt: { type: 'integer', description: 'Unix milliseconds. Clients must display snapshot age.' } } }] } } },
  } },
  paths: {
    [base]: { parameters: [walletParameter], get: operation('Read owned wallet', ref('Wallet')) },
    [`${base}/attempts`]: { parameters: [walletParameter], get: operation('List payment attempts', ref('AttemptPage'), undefined, [cursorParameter]), post: operation('Create or recover idempotent payment attempt', ref('Attempt'), ref('Intent'), [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[a-zA-Z0-9_-]{16,128}$' } }]) },
    [`${base}/attempt-by-key/{key}`]: { parameters: [walletParameter, { name: 'key', in: 'path', required: true, schema: string }], get: operation('Recover existing attempt by key', ref('Attempt')) },
    [`${base}/attempts/{attemptId}`]: { parameters: [walletParameter, attemptParameter], get: operation('Read persisted attempt', ref('Attempt')) },
    [`${base}/attempts/{attemptId}/approve`]: { parameters: [walletParameter, attemptParameter], post: operation('Approve exact recorded Soroban authorization', ref('Attempt'), ref('Approval')) },
    [`${base}/attempts/{attemptId}/approval/options`]: { parameters: [walletParameter,attemptParameter], post: operation('Begin session-bound transfer approval', { type: 'object', required: ['requestID','attempt','expiresAt','options'], properties: { requestID: string, attempt: ref('Attempt'), expiresAt: {type:'string',format:'date-time'}, options: {type:'object',description:'WebAuthn options with contract-derived challenge, authorized credentials and required user verification.'} } }, {type:'object',additionalProperties:false}) },
    [`${base}/attempts/{attemptId}/approval/verify`]: { parameters: [walletParameter,attemptParameter], post: operation('Approve using a one-time transfer-bound WebAuthn assertion', ref('Attempt'), ref('PasskeyAssertion')) },
    [`${base}/attempts/{attemptId}/check`]: { parameters: [walletParameter, attemptParameter], post: operation('Read existing status without broadcasting', ref('Attempt'), { type: 'object', additionalProperties: false }) },
    [`${base}/attempts/{attemptId}/cancel`]: { parameters: [walletParameter, attemptParameter], post: operation('Cancel an unsigned unleased attempt', ref('Attempt'), { type: 'object', additionalProperties: false }) },
    [`${base}/balance`]: { parameters: [walletParameter], get: operation('Read ledger-stamped balance snapshot', ref('Balance')) },
    [`${base}/history`]: { parameters: [walletParameter], get: operation('Read independently verified transfer history', ref('HistoryPage'), undefined, [cursorParameter]) },
  },
};

