import { rpc } from '@stellar/stellar-sdk';
import { db, getCredentials } from '../store.js';
import { getConfig, TESTNET_RPC_URL } from '../config.js';
import { PaymentError } from '../payments/model.js';
import { readPaymentManifest } from './manifest.js';
import { PinnedAccountAdapter } from './pinned-adapter.js';
import { verifyTestnetDeployment } from './deployment-evidence.js';
import { readBackupRecoveryEvidence } from './recovery-evidence.js';

/** Read-only operator audit. Does not run migrations, enroll keys, submit a
 * transaction, update a wallet policy or mark a physical recovery drill complete.
 * A missing/expired RPC transaction is unverified, not permission to bypass proof.
 */
try {
  if (process.argv.length !== 2 || !process.env.WALLET_PAYMENT_MANIFEST) throw Error('RECOVERY_AUDIT_MANIFEST_REQUIRED');
  const manifest = await readPaymentManifest(process.env.WALLET_PAYMENT_MANIFEST);
  const config = getConfig();
  const server = new rpc.Server(TESTNET_RPC_URL, { timeout: 20 });
  const adapter = new PinnedAccountAdapter(server, manifest.accounts);
  let failed = false;
  for (const account of manifest.accounts) {
    try {
      const current = await adapter.current(account.address);
      if (!current.recoveryReady) throw Error('ONCHAIN_BACKUP_NOT_READY');
      await verifyTestnetDeployment({ contractAddress: account.address, wasmSha256: account.accountWasmHash, deploymentTransactionHash: account.deploymentTransactionHash, sourceCommit: 'ddc327eb92d63709436da3a8455f641c2d5476c5' }, server);
      const proof = await readBackupRecoveryEvidence(server, account, await getCredentials(account.owner), { rpID: config.rpID, origin: config.origin });
      console.log(JSON.stringify({ ...proof, onChainBackupConfigured: true, deploymentTransactionVerified: true, policyFingerprint: current.fingerprint }));
    } catch (error) {
      failed = true;
      console.error(JSON.stringify({ walletId: account.walletId, address: account.address, backupSpendVerified: false, physicalDeviceIndependenceVerified: false, error: error instanceof PaymentError ? error.code : 'RECOVERY_EVIDENCE_UNAVAILABLE_OR_INVALID' }));
    }
  }
  if (failed) process.exitCode = 1;
} catch {
  console.error('RECOVERY_AUDIT_CONFIGURATION_OR_RPC_FAILED');
  process.exitCode = 1;
} finally { await db.end(); }
