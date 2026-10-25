# MVP task backlog

## Contributor A — Wallet frontend
- [ ] A1 Bootstrap React/TypeScript app, routing, lint and tests.
- [ ] A2 Wallet onboarding, passkey enrollment and reconnect UX.
- [ ] A3 Wallet overview: address, confirmed XLM balance, network and activity.
- [ ] A4 Receive screen: supported destination instructions, copy and QR.
- [ ] A5 Send screen: address validation feedback, exact amount, fee preview, approval and statuses.
- [ ] A6 Transaction history, detail and receipt links.
- [ ] A7 Responsive, keyboard-accessible errors and recovery screens.

## Contributor B — Stellar integration
- [ ] B1 Evaluate/pin smart-account contract and SDK versions; Testnet deployment spike.
- [ ] B2 Implement passkey authorization, wallet discovery and independent backup recovery.
- [ ] B3 Define API schemas and persistent wallet/payment-attempt records.
- [ ] B4 Implement native XLM SAC transfer and relayer with strict authorization boundaries.
- [ ] B5 Implement confirmation verification, event identity, balance and history indexing.
- [ ] B6 Implement idempotency, safe retry, uncertain outcomes and monitoring cursor.
- [ ] B7 Test signer changes, unsupported destinations, insufficient balance and RPC failures.

## Shared gates
- [ ] S1 Agree architecture, API contract, wallet ownership/recovery and threat model.
- [ ] S2 Configure CI, PR review and branch rules.
- [ ] S3 End-to-end Testnet demo: create, recover, receive, send, verify.
- [ ] S4 Security review and documented limitations.
- [ ] S5 Stretch: integrate one supplier payment intent with Cherry Money; Testnet only.

## Suggested folder ownership
```
apps/web/                 # A
apps/api/                 # B
packages/wallet-core/     # B
packages/shared-types/    # joint
packages/ui/              # A
contracts/                # B
tests/e2e/                # joint
docs/                     # joint
.github/workflows/        # joint
```
