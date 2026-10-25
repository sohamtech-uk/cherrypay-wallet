import { StrKey } from '@stellar/stellar-sdk';
import { ACCOUNT_V080_HASH } from './pinned-adapter.js';
import { SMART_ACCOUNT_KIT, rejectLegacyAccountWasm } from './kit-manifest.js';
import { requireThat } from '../payments/model.js';

/**
 * Operator preflight for the canonical Smart Account Kit v0.8.0 deployment.
 * This validates configuration, NOT proof of deployment or recovery.
 * On-chain evidence is independently checked by PinnedAccountAdapter.
 */
export const TESTNET_V080 = Object.freeze({
  networkPassphrase: 'Test SDF Network ; September 2015',
  accountWasmHash: 'c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1',
  verifierAddress: 'CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F',
  verifierWasmHash: 'e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76',
  accountUploadTx: '208bd769dbfb1de10c03b9d2072ad2099eeab60e77a63a40cf2bf775ecca0983',
  upstreamManifest: 'https://github.com/stellar/smart-account-kit/blob/main/docs/deployments-stellar-accounts-0.8-2026-10-25.md',
});

export function validateKitV080DeploymentConfig(config: {
  networkPassphrase: string;
  accountWasmHash: string;
  verifierAddress: string;
  verifierWasmHash: string;
}) {
  rejectLegacyAccountWasm(config.accountWasmHash);
  requireThat(ACCOUNT_V080_HASH === TESTNET_V080.accountWasmHash, 'PINNED_ACCOUNT_HASH_DRIFT');
  requireThat(config.networkPassphrase === TESTNET_V080.networkPassphrase, 'TESTNET_ONLY');
  requireThat(config.accountWasmHash === TESTNET_V080.accountWasmHash, 'UNAPPROVED_ACCOUNT_WASM');
  requireThat(StrKey.isValidContract(config.verifierAddress) && config.verifierAddress === TESTNET_V080.verifierAddress, 'UNAPPROVED_WEBAUTHN_VERIFIER');
  requireThat(config.verifierWasmHash === TESTNET_V080.verifierWasmHash, 'UNAPPROVED_VERIFIER_WASM');
  // The older integration manifest is intentionally blocked; never substitute it.
  requireThat(SMART_ACCOUNT_KIT.accountWasmHash !== config.accountWasmHash, 'LEGACY_MANIFEST_MUST_REMAIN_BLOCKED');
  return Object.freeze({ ...TESTNET_V080, validated: true as const });
}
