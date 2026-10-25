import { db, initializeStore } from '../store.js';
import { requireThat } from '../payments/model.js';
import { readPaymentManifest } from './manifest.js';
import { provisionAccounts } from './provision.js';
import { startupErrorCode } from '../startup-error.js';

try {
  const args = process.argv.slice(2);
  requireThat(args.length <= 1 && (!args.length || ['--check','--apply'].includes(args[0])), 'INVALID_PROVISION_ARGUMENTS');
  requireThat(process.env.WALLET_PAYMENT_MANIFEST, 'PAYMENT_MANIFEST_PATH_REQUIRED');
  const manifest = await readPaymentManifest(process.env.WALLET_PAYMENT_MANIFEST);
  const apply = args[0] === '--apply';
  if (apply) await initializeStore();
  console.log(JSON.stringify(await provisionAccounts(manifest, apply), null, 2));
} catch (error) {
  console.error(startupErrorCode(error,'WALLET_PROVISION_FAILED'));
  process.exitCode = 1;
} finally { await db.end(); }
