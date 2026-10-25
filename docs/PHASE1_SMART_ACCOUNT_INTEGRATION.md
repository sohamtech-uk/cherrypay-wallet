# Phase 1: Stellar Testnet smart-account integration gate

Status: IN PROGRESS. No smart account deployed, no live transfer authorized. Wallet deployment and payment routes remain disabled.

## Scope and dependencies
1. Pin a reviewed Stellar Smart Account Kit release and compatible audited contract artifact; record source commit, WASM hash, SDK and Soroban RPC versions. Verify WebAuthn P-256 support and contract signature encoding against actual contract source. Do not infer compatibility from the SDK name.
2. Build a contract-specific adapter for registration, deployment, on-chain signer policy lookup, transfer-bound authorization, and independent backup/recovery. Keep the existing WebAuthn registration/authentication service as identity verification, not transaction signing.
3. Provision a wallet_onchain_accounts record only after the deployed C-address, owner, network, signer policy and independent recovery have been verified on Testnet. Use a server-side authenticated account; reject caller-supplied owner and contract address.
4. Enforce exact Testnet network passphrase, native XLM SAC contract, destination, integer stroops, nonce and expiry in the signed Soroban authorization payload. The relayer must never sign user spending authorization or rotate signers.
5. Require a separately enrolled backup passkey to be added to the on-chain policy and demonstrate recovery after primary credential loss. A second credential in PostgreSQL alone does not satisfy recoveryReady.
6. Validate C-to-G and C-to-C native XLM SAC transfers with independent getTransaction + committed transfer event verification, including invalid signature, altered destination/amount, replay, expired auth and signer rotation.
7. Check account storage TTL, rent/restore costs, upgrade governance, sponsor fee ceiling, rate limits and safe recovery after RPC timeouts.

## Implementation sequence
- Gate A: contract selection and dependency/license/security review with pinned artifacts.
- Gate B: adapter interfaces and contract-specific test vectors (without enabling routes).
- Gate C: Testnet deployment and on-chain WebAuthn authorization.
- Gate D: independent backup signer and loss-of-device recovery drill.
- Gate E: integration with existing PostgreSQL PaymentRepository and frontend adapter, only after all previous gates pass.

## Required evidence
- Contract deployment transaction, C-address, WASM SHA-256, verified source tag and network.
- Testnet signed transaction hashes and exact verified committed SAC transfer events.
- Two-device recovery proof and negative security tests.
- PostgreSQL integration/concurrency tests and documented operational rollback.
- CI typecheck, tests, build, and reviewer approval.

## Existing behavior to preserve
- /health and /api/v1/network continue to report walletDeploymentEnabled:false.
- registerPaymentRoutes(app) remains disabled by default (503).
- No Mainnet configuration, secret keys in source, arbitrary contract calls, or automatic replacement of unknown transfers.
- Wallet Backend is read-only indexing infrastructure, not spending authorization.


## Security gate update

The manifest's legacy account WASM is now explicitly blocked; upstream identifies
it as predating GHSA-jpg9-m7w4-c7wc. No replacement is automatically approved.
See [workshop implementation status](WORKSHOP_PHASE_STATUS.md) for the reviewed-code,
SDK compatibility, approval API, receive-route and live-device acceptance gates.
