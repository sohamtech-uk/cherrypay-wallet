import { rpc } from '@stellar/stellar-sdk';
import { db, initializeStore } from '../store.js';
import { TESTNET_RPC_URL } from '../config.js';
import { readPaymentManifest } from './manifest.js';
import { PinnedAccountAdapter } from './pinned-adapter.js';

/** Operator-only, read-only on-chain backup verifier.
 * This does not enroll a signer or substitute for a lost-primary-device recovery drill.
 */
try {
  if (process.argv.length !== 2 || !process.env.WALLET_PAYMENT_MANIFEST) throw Error('RECOVERY_AUDIT_MANIFEST_REQUIRED');
  await initializeStore();
  const manifest = await readPaymentManifest(process.env.WALLET_PAYMENT_MANIFEST);
  const adapter = new PinnedAccountAdapter(new rpc.Server(TESTNET_RPC_URL,{timeout:20}),manifest.accounts);
  let failed = false;
  for (const account of manifest.accounts) {
    try {
      const result = await adapter.current(account.address);
      if (!result.recoveryReady) throw Error('ONCHAIN_BACKUP_NOT_READY');
      console.log(JSON.stringify({walletId:account.walletId,owner:account.owner,address:account.address,recoveryReady:true,policyFingerprint:result.fingerprint}));
    } catch {
      failed = true;
      console.error(JSON.stringify({walletId:account.walletId,owner:account.owner,address:account.address,recoveryReady:false,error:'ONCHAIN_BACKUP_VALIDATION_FAILED'}));
    }
  }
  if (failed) process.exitCode = 1;
} catch {
  console.error('RECOVERY_AUDIT_CONFIGURATION_OR_RPC_FAILED');
  process.exitCode = 1;
} finally { await db.end(); }
