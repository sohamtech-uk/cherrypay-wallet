# Hackathon submission — XLM-only Cherry Wallet

## Non-negotiable scope
Standalone Stellar Testnet wallet; native XLM only. No USDC, trustlines, token swaps, FX, payroll, or Cherry Pay dependency. A C-address receives native XLM through the Stellar native-asset SAC contract invocation, **not** a classic payment operation to a C-address.

## Release blockers (must demonstrate, not just configure)
- [ ] Register a primary passkey; keep credentials on the authenticator, not in application secrets.
- [ ] Deploy a smart-account C-address using reviewed v0.8.0 contract WASM; reject legacy vulnerable WASM.
- [ ] Enroll a different physical backup authenticator as an independent on-chain signer.
- [ ] Exercise recovery using the backup authenticator without the primary.
- [ ] Validate contract code hash, verifier hash and signer policies against on-chain state.
- [ ] Provision the verified wallet with the operator manifest.
- [ ] Fund wallet with Testnet XLM via a compatible native SAC transfer.
- [ ] Send a native XLM transfer using a user-approved WebAuthn assertion and restricted fee relayer.
- [ ] Confirm the exact chain transfer event, transaction hash, recipient and stroop amount; prove idempotency.
- [ ] Display confirmed XLM balance and history; test pending, failure and RPC-outage states.
- [ ] Run API and web typechecks, tests and CI; record actual results.
- [ ] Capture a demo video with the end-to-end flow and evidence links.

## Current repository constraints
The existing API already models a single native XLM asset through `NATIVE_SAC = Asset.native().contractId(PASSPHRASE)` and exposes balance/history and send endpoints. It does **not** implement user-facing automatic wallet deployment, automatic on-chain backup enrollment or recovery ceremonies. Creating two application passkeys alone is **not** sufficient to mark wallet recovery ready.

## Minimum demo sequence
1. Register primary passkey and backup passkey.
2. Deploy and attest wallet using a controlled Testnet deployer.
3. Independently verify backup recovery and provision the account.
4. Receive Testnet XLM into the C-address via a supported contract transfer.
5. Sign a 1 XLM transfer to a valid Testnet destination.
6. Display confirmed receipt, balance change and transaction history.
7. Demonstrate idempotent retry and backup recovery.

## Fail-closed criteria
Never report deployment, spendability, recovery readiness or confirmed settlement from application enrollment alone. If any on-chain proof, relayer configuration or network check is missing, disable sending and show the specific blocker. No real-world value is represented by Testnet XLM.

## Integration boundary
Cherry Pay and Cherry Money are not involved in this demo. Future integration must be separately enabled through authenticated, consent-bound configuration.
