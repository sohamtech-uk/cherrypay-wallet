import { db, initializeStore } from '../store.js';
import { requireThat } from '../payments/model.js';
import { readPaymentManifest } from './manifest.js';
import { parseProvisionArguments, provisionAccounts } from './provision.js';
import { startupErrorCode } from '../startup-error.js';

try {
  const { apply, enableContractRoutes } = parseProvisionArguments(process.argv.slice(2));
  requireThat(process.env.WALLET_PAYMENT_MANIFEST, 'PAYMENT_MANIFEST_PATH_REQUIRED');
  const manifest = await readPaymentManifest(process.env.WALLET_PAYMENT_MANIFEST);
  if (apply) await initializeStore();
  console.log(JSON.stringify(await provisionAccounts(manifest, apply, { enableContractRoutes }), null, 2));
} catch (error) {
  console.error(startupErrorCode(error, 'WALLET_PROVISION_FAILED'));
  process.exitCode = 1;
} finally { await db.end(); }
