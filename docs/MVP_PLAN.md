# Cherry Pay Wallet — MVP plan

## Goal
Build an embedded, customer-controlled Stellar Testnet XLM wallet with passkey-based authorization, independent recovery, send/receive, balances, activity, and transaction verification. The wallet is standalone; Cherry Money invoice, purchase-order, supplier, and payroll integrations are later consumers, not wallet business logic.

## Product boundaries
- **Wallet app**: onboarding, wallet discovery, passkeys, signing UX, balances, receive/send, history, settings.
- **Payment execution**: relayer, exact payment intent, authorization validation, submission, monitoring, retry/recovery.
- **Cherry Money**: invoice, PO, supplier, payroll, HMRC, VAT and accounting workflows. Do not duplicate them.
- **Network**: Stellar Testnet only for MVP. No production funds, no live accounting posting.

## MVP acceptance criteria
1. User creates a smart wallet using a passkey without external wallet installation.
2. User registers an independent backup credential and proves recovery after losing the primary credential.
3. User can reconnect to the same wallet after logout and device/browser restart.
4. Wallet shows confirmed XLM balance, network, address and activity.
5. User can receive XLM through a supported route, with compatible instructions/QR.
6. User reviews recipient, exact XLM amount, fee and network before authorizing a send.
7. Authorization binds to the exact transfer, not just login; relayer cannot independently spend user funds.
8. A successful native-XLM transfer is independently verified and linked to an immutable attempt/receipt.
9. Duplicate clicks, timeouts, and retries do not create unintended extra transfers.
10. Errors (insufficient funds, unsupported address, rejected signing, RPC outage) are actionable.
11. UI is responsive and keyboard accessible; CI passes.
12. Customer private signing keys are never stored in browser localStorage, source control or application logs.

## Out of scope for wallet MVP
Invoice authoring, PO matching, payroll calculation, tax, accounting journals, fiat on/off ramps, FX, multi-asset, AI automation, mainnet launch. Optional Freighter/external-wallet connection is deferred.

## Architecture decisions to validate before implementation
- Smart-account contract, SDK, relayer and WebAuthn version compatibility; pin versions and document deployment IDs.
- Network support for smart-account (C-address) and classic-account (G-address) XLM transfers using native XLM SAC; verify each route.
- Relying-party ID, allowed origins, device/passkey recovery and contract upgrade governance.
- Exact amounts in stroops or safe fixed-decimal representation; no JavaScript floating-point money arithmetic.
- Signed transaction persistence, submission idempotency, unknown-outcome recovery and verified transfer-event identity.
- Security review of dependencies and deployed contract artifacts; do not assume upstream audit covers our integration.

## Milestones (indicative, not guaranteed)
| Days | Contributor A — UI | Contributor B — Stellar/security | Joint gate |
| --- | --- | --- | --- |
| 1 | React/TypeScript scaffold and navigation | Smart-account feasibility spike, contract/SDK selection | API contracts, threat model, CI, Testnet routes agreed |
| 2–3 | Onboarding, passkey and wallet dashboard screens | Passkey registration, deployment, discovery, backup credential | Create/reconnect/recover on Testnet |
| 4–5 | Send/receive, review, balance and status screens | SAC transfer, relayer, fee estimate, verification | Real Testnet transfer and receipt |
| 6–7 | History, accessibility and failure UX | Safe retry, RPC recovery, monitoring, integration tests | E2E security and recovery demonstration |
| 8–10 (stretch) | Supplier bill approval/payment screen | Cherry Pay supplier payment-intent adapter | Testnet supplier payment with no live ledger posting |

## Exit gate
Demonstrate: create → backup/recover → fund → review/sign → send → verify → history. Prove retry safety and testnet-only boundaries. Record contract address, transaction hashes, tests, known limitations and a short demo.

## Future Cherry Money integration
1. Supplier bill payment (shared bill reservation and approval).
2. Customer invoice checkout and verified receipt allocation.
3. PO matched-bill payment and separately approved advances.
4. Payroll employee-level payout allocation and restricted access.
Do not build those modules inside the wallet.
