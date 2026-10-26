import { createHash } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import type { PolicyReader } from '../payments/model.js';

/**
 * Gate D: independently verify on-chain recovery before declaring readiness.
 * WebAuthn registration is off-chain identity only; it does not grant contract authority.
 */
export type SignerPolicy = Readonly<{
  contractAddress: string;
  network: 'TESTNET';
  primaryCredentialId: string;
  backupCredentialId: string | null;
  onChainAuthorizedCredentialIds: readonly string[];
  recoveryMethod: 'independent-passkey' | 'none';
  ledger: number;
}>;

export interface OnChainSignerPolicySource {
  readPolicy(contractAddress: string): Promise<SignerPolicy>;
}

export function evaluateRecoveryPolicy(policy: SignerPolicy): { fingerprint: string; recoveryReady: boolean } {
  if (!StrKey.isValidContract(policy.contractAddress) ||
      policy.network !== 'TESTNET' ||
      !Number.isSafeInteger(policy.ledger) || policy.ledger <= 0 ||
      !policy.primaryCredentialId ||
      new Set(policy.onChainAuthorizedCredentialIds).size !== policy.onChainAuthorizedCredentialIds.length) {
    throw new Error('INVALID_ONCHAIN_SIGNER_POLICY');
  }
  const ids = new Set(policy.onChainAuthorizedCredentialIds);
  if (!ids.has(policy.primaryCredentialId)) throw new Error('PRIMARY_NOT_AUTHORIZED_ONCHAIN');
  const recoveryReady = policy.recoveryMethod === 'independent-passkey' &&
    !!policy.backupCredentialId &&
    policy.backupCredentialId !== policy.primaryCredentialId &&
    ids.has(policy.backupCredentialId);
  const fingerprint = createHash('sha256').update(JSON.stringify([
    policy.network, policy.contractAddress, policy.primaryCredentialId,
    policy.backupCredentialId, [...ids].sort(), policy.recoveryMethod,
  ])).digest('hex');
  return { fingerprint, recoveryReady };
}

/** The injected source MUST query the deployed contract at a confirmed ledger. */
export class VerifiedOnChainPolicyReader implements PolicyReader {
  constructor(private readonly source: OnChainSignerPolicySource) {}
  async current(address: string): Promise<{ fingerprint: string; recoveryReady: boolean }> {
    if (!StrKey.isValidContract(address)) throw new Error('INVALID_WALLET_ADDRESS');
    const policy = await this.source.readPolicy(address);
    if (policy.contractAddress !== address) throw new Error('ONCHAIN_POLICY_ADDRESS_MISMATCH');
    return evaluateRecoveryPolicy(policy);
  }
}

/** Never mark recovery ready on the basis of local credential count. */
export function requireRecoveryReady(policy: { recoveryReady: boolean }): void {
  if (!policy.recoveryReady) throw new Error('ONCHAIN_RECOVERY_NOT_READY');
}
