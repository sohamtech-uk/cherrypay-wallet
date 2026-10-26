import { pathToFileURL } from 'node:url';

const unknownInvoice = '/api/v1/payment-requests/00000000-0000-4000-8000-000000000000';
export function checkedOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw Error('Use an HTTPS origin (HTTP is allowed only for localhost), without credentials, path or query.');
  }
  return url.origin;
}

/** GET-only public checks. No login, signing, funding, payment creation or resubmission. */
export async function checkJudgeReadiness(origin, { fetcher = fetch, requirePayments = false } = {}) {
  origin = checkedOrigin(origin);
  const checks = [];
  async function check(name, action) {
    try { await action(); checks.push({ name, passed: true }); }
    catch (error) { checks.push({ name, passed: false, message: error.message }); }
  }
  const require = (value, message) => { if (!value) throw Error(message); };
  async function get(path, expected = 200, type = 'application/json') {
    let response;
    try { response = await fetcher(origin + path, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: type } }); }
    catch { throw Error(`${path}: request unavailable (network, timeout or redirect)`); }
    require(response.status === expected, `${path}: expected HTTP ${expected}, received ${response.status}`);
    require(response.headers.get('content-type')?.includes(type), `${path}: expected ${type}`);
    return response;
  }
  async function json(path, status) {
    const response = await get(path, status);
    try { return await response.json(); } catch { throw Error(`${path}: invalid JSON`); }
  }
  let health, capabilities;
  await check('API liveness and Testnet', async () => {
    health = await json('/health');
    require(health.status === 'ok' && health.network === 'TESTNET', 'Expected healthy Testnet API');
    require(typeof health.walletDeploymentEnabled === 'boolean' && typeof health.walletPaymentsEnabled === 'boolean', 'Missing runtime availability flags');
  });
  await check('Database readiness', async () => {
    const ready = await json('/ready');
    require(ready.status === 'ready' && ready.network === 'TESTNET', 'Database is not ready on Testnet');
  });
  await check('Consistent runtime capabilities', async () => {
    capabilities = await json('/api/v1/smart-account/capabilities');
    require(capabilities.network === 'TESTNET' && capabilities.asset === 'XLM', 'Expected Testnet XLM capability');
    require(health && capabilities.spendingEnabled === health.walletPaymentsEnabled && capabilities.deploymentEnabled === health.walletDeploymentEnabled, 'Health and capabilities disagree');
    require(capabilities.capabilityScope === 'runtime' && capabilities.walletVerificationRequired === true, 'Missing runtime scope / per-wallet verification boundary');
    require(capabilities.recoveryEnabled === false, 'Independent recovery needs a separate evidence review');
  });
  if (requirePayments) await check('Payment demo runtime enabled', async () => {
    require(health?.walletPaymentsEnabled === true && capabilities?.spendingEnabled === true && health?.walletDeploymentEnabled === true, 'Payment/deployment availability is not consistently enabled; resolve configuration before live acceptance');
  });
  await check('Unsupported Testnet cross-chain funding stays disabled', async () => {
    const aurora = await json('/api/v1/aurora/capabilities');
    require(aurora.enabled === false && aurora.network === 'TESTNET' && aurora.supported === false, 'Unexpected Aurora Testnet funding capability');
  });
  await check('Public API contract includes the demo flow', async () => {
    const spec = await json('/api/v1/openapi.json');
    require(spec.openapi === '3.1.0', 'Expected OpenAPI 3.1');
    for (const [path, method] of [
      ['/api/v1/passkeys/onboarding/options', 'post'],
      ['/api/v1/wallets/{walletId}/invoices', 'post'],
      ['/api/v1/payment-requests/{requestId}', 'get'],
      ['/api/v1/wallets/{walletId}/attempts/{attemptId}/approval/verify', 'post'],
    ]) require(spec.paths?.[path]?.[method], `API contract missing ${method.toUpperCase()} ${path}`);
  });
  await check('Invoice route returns the expected typed error', async () => {
    const disabled = !requirePayments && health?.walletPaymentsEnabled === false;
    const missing = await json(unknownInvoice, disabled ? 503 : 404);
    require(missing.error === (disabled ? 'PAYMENT_INTEGRATION_NOT_CONFIGURED' : 'PAYMENT_REQUEST_NOT_FOUND'), 'Invoice route is unavailable or returned an unexpected error');
  });
  for (const path of ['/', '/developers', '/pay/00000000-0000-4000-8000-000000000000']) {
    await check(`Web shell ${path}`, async () => {
      const response = await get(path, 200, 'text/html'), html = await response.text();
      require(/<div\s+id=["']root["']/.test(html), `${path}: missing app root`);
      require(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), `${path}: missing frame protection`);
      if (path !== '/') return;
      const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["'](\/assets\/[^"']+\.js)["']/g)].map(match => match[1]);
      require(scripts.length > 0, 'Missing built JavaScript entry point');
      for (const script of scripts) {
        const asset = await get(script, 200, 'javascript');
        require((await asset.text()).length > 0, 'Empty JavaScript bundle');
      }
    });
  }
  return {
    checkedAt: new Date().toISOString(), origin, network: 'TESTNET', mode: 'read-only',
    passed: checks.every(check => check.passed), checks,
    notVerified: ['Physical passkey ceremony', 'On-chain payment and receipt', 'Invoice allocation after settlement', 'Independent recovery', 'Mobile rendering and screen-reader usability', 'Deployed source revision'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), flags = args.filter(arg => arg.startsWith('--'));
    if (flags.some(flag => flag !== '--require-payments') || args.filter(arg => !arg.startsWith('--')).length > 1) throw Error('Usage: node scripts/check-judge-readiness.mjs [https://origin] [--require-payments]');
    const report = await checkJudgeReadiness(args.find(arg => !arg.startsWith('--')) ?? 'https://wallet.cherrymoney.co.uk', { requirePayments: flags.includes('--require-payments') });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
