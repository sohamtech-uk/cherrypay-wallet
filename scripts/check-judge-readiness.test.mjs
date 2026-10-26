import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkedOrigin, checkJudgeReadiness } from './check-judge-readiness.mjs';

function fixture({ payments = false, patch = {} } = {}) {
  const routes = {
    '/health': { status: 'ok', network: 'TESTNET', walletDeploymentEnabled: payments, walletPaymentsEnabled: payments },
    '/ready': { status: 'ready', network: 'TESTNET' },
    '/api/v1/smart-account/capabilities': { network: 'TESTNET', asset: 'XLM', capabilityScope: 'runtime', walletVerificationRequired: true, deploymentEnabled: payments, spendingEnabled: payments, recoveryEnabled: false },
    '/api/v1/aurora/capabilities': { enabled: false, supported: false, network: 'TESTNET' },
    '/api/v1/openapi.json': { openapi: '3.1.0', paths: {
      '/api/v1/passkeys/onboarding/options': { post: {} }, '/api/v1/wallets/{walletId}/invoices': { post: {} },
      '/api/v1/payment-requests/{requestId}': { get: {} }, '/api/v1/wallets/{walletId}/attempts/{attemptId}/approval/verify': { post: {} },
    } },
    ...patch,
  };
  return async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    assert.equal(new URL(url).origin, 'https://wallet.example');
    const path = new URL(url).pathname;
    if (path in routes) {
      const value = routes[path];
      if (value instanceof Error) throw value;
      if (value instanceof Response) return value;
      return Response.json(value);
    }
    if (path.startsWith('/api/v1/payment-requests/')) return Response.json({ error: payments ? 'PAYMENT_REQUEST_NOT_FOUND' : 'PAYMENT_INTEGRATION_NOT_CONFIGURED' }, { status: payments ? 404 : 503 });
    if (path.startsWith('/assets/')) return new Response('/* fixture */', { headers: { 'content-type': 'text/javascript' } });
    return new Response('<div id="root"></div><script type="module" src="/assets/app.js"></script>', { headers: { 'content-type': 'text/html', 'content-security-policy': "frame-ancestors 'none'" } });
  };
}

test('bootstrap checks are read-only and never label a payment or UX as verified', async () => {
  const report = await checkJudgeReadiness('https://wallet.example', { fetcher: fixture() });
  assert.equal(report.passed, true); assert.equal(report.mode, 'read-only');
  assert.ok(report.notVerified.includes('On-chain payment and receipt'));
});
test('demo mode requires deployment and payment runtime, not merely healthy HTTP', async () => {
  assert.equal((await checkJudgeReadiness('https://wallet.example', { fetcher: fixture(), requirePayments: true })).passed, false);
  assert.equal((await checkJudgeReadiness('https://wallet.example', { fetcher: fixture({ payments: true }), requirePayments: true })).passed, true);
});
test('contradictory capabilities fail even when both endpoints return 200', async () => {
  const fetcher = fixture({ patch: { '/health': { status: 'ok', network: 'TESTNET', walletDeploymentEnabled: false, walletPaymentsEnabled: true } } });
  const result = await checkJudgeReadiness('https://wallet.example', { fetcher });
  assert.equal(result.passed, false); assert.match(result.checks.find(c => !c.passed).message, /disagree/);
});
test('HTML fallback cannot masquerade as an API schema', async () => {
  const fetcher = fixture({ patch: { '/api/v1/openapi.json': new Response('<html/>', { headers: { 'content-type': 'text/html' } }) } });
  assert.equal((await checkJudgeReadiness('https://wallet.example', { fetcher })).passed, false);
});
test('wrong networks, database failures and unsupported funding fail independently', async () => {
  const fetcher = fixture({ patch: { '/health': { status: 'ok', network: 'MAINNET' }, '/ready': new Error('private connection secret'), '/api/v1/aurora/capabilities': { enabled: true, supported: true, network: 'TESTNET' } } });
  const report = await checkJudgeReadiness('https://wallet.example', { fetcher });
  assert.equal(report.passed, false); assert.ok(report.checks.filter(c => !c.passed).length >= 3);
  assert.ok(!JSON.stringify(report).includes('private connection secret'));
});
test('rejects ambiguous origins and embedded credentials before making a request', () => {
  for (const origin of ['http://wallet.example', 'https://user:secret@wallet.example', 'https://wallet.example/path', 'https://wallet.example?token=secret', 'https://wallet.example#fragment']) assert.throws(() => checkedOrigin(origin));
  assert.equal(checkedOrigin('http://localhost:8080'), 'http://localhost:8080');
});
test('missing assets fail instead of accepting a successful SPA shell', async () => {
  const base = fixture();
  const fetcher = async (url, options) => url.includes('/assets/') ? new Response('', { status: 404 }) : base(url, options);
  assert.equal((await checkJudgeReadiness('https://wallet.example', { fetcher })).passed, false);
});
