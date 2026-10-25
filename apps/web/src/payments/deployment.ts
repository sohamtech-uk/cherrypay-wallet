import { addressKind } from './model';
import { object, text } from './api';

const statuses = ['NOT_STARTED','PENDING','AWAITING_PASSKEY','SUBMITTED','CONFIRMED','ACTIVE','FAILED'];
export type DeploymentView = { status: string; enabled: boolean; address?: string; transactionHash?: string; ledger?: number };
/** A C-address is displayed only when the server reports verified deployment and
 * exact primary binding. It never creates a PaymentAdapter or recovery claim. */
export function parseDeployment(value: unknown): DeploymentView {
  const data = object(value), status = text(data.status);
  if (!statuses.includes(status) || typeof data.deploymentEnabled !== 'boolean') throw Error('Invalid deployment status.');
  if (!data.deploymentEnabled) return { status, enabled: false };
  if (data.network !== 'TESTNET' || data.spendingEnabled !== false || data.recoveryReady !== false || typeof data.onChainSignerBound !== 'boolean') throw Error('Invalid deployment boundary.');
  if (data.transactionHash != null && (typeof data.transactionHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.transactionHash))) throw Error('Invalid deployment transaction.');
  if (status === 'CONFIRMED') {
    if (data.onChainSignerBound !== true || typeof data.address !== 'string' || addressKind(data.address) !== 'contract' ||
      typeof data.transactionHash !== 'string' || !Number.isSafeInteger(data.confirmedLedger) || Number(data.confirmedLedger) < 1 ||
      data.primaryRuleId !== 0 || typeof data.primaryCredentialId !== 'string' || !/^[A-Za-z0-9_-]{1,1279}$/.test(data.primaryCredentialId)) throw Error('Unverified deployment binding.');
    return { status, enabled: true, address: data.address, transactionHash: data.transactionHash, ledger: Number(data.confirmedLedger) };
  }
  if (status === 'ACTIVE' || data.onChainSignerBound || data.address != null) throw Error('Unverified deployment state.');
  return { status, enabled: true, transactionHash: typeof data.transactionHash === 'string' ? data.transactionHash : undefined };
}
