/**
 * Stellar Smart Account Kit integration manifest.
 * Upstream: https://github.com/stellar/smart-account-kit
 * Upstream package version observed: 0.8.0.
 * Contract provenance: OpenZeppelin/stellar-contracts@1e513890ecf79833c9d6e7ef38a9358001c0b111
 * This is a Testnet-only, read-only integration manifest. No wallet is deployed here.
 */
export const SMART_ACCOUNT_KIT = Object.freeze({
  name: 'smart-account-kit',
  version: '0.8.0',
  requiredStellarSdk: '16.3.x',
  network: 'TESTNET',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  accountWasmHash: '1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a',
  webauthnVerifierAddress: 'CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F',
  webauthnVerifierWasmHash: 'e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76',
  sourceCommit: '1e513890ecf79833c9d6e7ef38a9358001c0b111',
  deploymentManifest: 'https://github.com/stellar/smart-account-kit/blob/main/docs/deployments-protocol-27-2026-07-09.md',
  securityStatus: 'BLOCKED_LEGACY_ACCOUNT_WASM',
  deploymentEnabled: false,
  spendingEnabled: false,
} as const);

/** A release number alone is not a reproducible dependency lock. */
export function requireSmartAccountIntegrationReady(): never {
  throw new Error('SMART_ACCOUNT_KIT_NOT_VERIFIED_OR_INSTALLED');
}


/** Upstream auth-digest-scheme.ts identifies this original artifact as predating
 * GHSA-jpg9-m7w4-c7wc. Never provision it, including on Testnet. */
export function rejectLegacyAccountWasm(wasmHash: string): void {
  if (wasmHash.toLowerCase() === SMART_ACCOUNT_KIT.accountWasmHash) throw new Error('KNOWN_UNSAFE_ACCOUNT_WASM');
}
