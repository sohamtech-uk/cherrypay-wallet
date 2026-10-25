import type { rpc } from '@stellar/stellar-sdk';
import { getCredentials } from '../store.js';
import { getConfig } from '../config.js';
import type { ApprovedAccount } from './pinned-adapter.js';
import { verifyTestnetDeployment } from './deployment-evidence.js';
import { readBackupRecoveryEvidence } from './recovery-evidence.js';

/** Trusted startup/provisioning gate. Receipt references alone are insufficient.
 * The current-code/rule reader must ALSO pass. Neither check establishes physical
 * device independence: that remains an operator-observed acceptance exercise.
 */
export async function verifyAccountAcceptance(account: ApprovedAccount, server: Pick<rpc.Server,'getNetwork'|'getTransaction'>) {
  await verifyTestnetDeployment({ contractAddress: account.address, wasmSha256: account.accountWasmHash,
    deploymentTransactionHash: account.deploymentTransactionHash, sourceCommit: 'ddc327eb92d63709436da3a8455f641c2d5476c5' }, server);
  const config = getConfig();
  return readBackupRecoveryEvidence(server, account, await getCredentials(account.owner), { rpID: config.rpID, origin: config.origin });
}
