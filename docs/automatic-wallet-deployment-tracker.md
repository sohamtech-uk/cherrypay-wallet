# Automatic Smart Wallet Deployment — implementation tracker

Branch: `feat/automatic-smart-wallet-state-machine` · PR #42 (draft)
Network: Stellar Testnet only. Canonical owner: normalized email. Contract: pinned Smart Account Kit v0.8.0.
Never enable spending or report ACTIVE without independent on-chain verification.

| Order | Deliverable | Status | Acceptance gate |
| --- | --- | --- | --- |
| 1 | Stellar transaction builder, pinned v0.8.0 | IN PROGRESS | Deterministic contract ID, exact initialization ABI, two independent P-256 signers, signed XDR and hash verified against SDK; simulation and fee checks |
| 2 | Actual RPC submission | PARTIAL | Existing `PinnedV080DeploymentAdapter.broadcast`; validate signed hash, reject network mismatch, preserve durable intent before sending, classify uncertain outcomes |
| 3 | Automatic reconciliation worker | NOT STARTED | Restart-safe scan of SUBMITTED/expired DEPLOYING; reconcile before any retry; fencing and backoff; transaction/ledger proof |
| 4 | Independent two-signer verification | PARTIAL | Existing `PinnedAccountAdapter.current` checks pinned WASM and two rules; trusted approval evidence and recovery transaction verification required |
| 5 | Activation and E2E | NOT STARTED | Atomic VERIFIED→ACTIVE transition with evidence, UI polling, crash/concurrency tests and real Testnet end-to-end |

## Existing foundations
- `020_wallet_deployment_state.sql`: jobs and events
- `021_deployment_intent.sql`: durable signed XDR outbox
- `deployment-state.ts`: worker leases and state transitions
- `deployment-coordinator.ts`: persist-before-broadcast
- `pinned-deployment-adapter.ts`: pinned RPC and policy verifier integration

## Security blockers
1. Need the **exact v0.8.0 contract constructor/init ABI and source-reviewed invocation** from the upstream contract/bindings. Do not substitute an assumed ABI or the blocked legacy WASM.
2. Relayer signing keys must come from protected runtime secrets, never from browser or database.
3. Recovery must be proven by an independent transaction, not inferred from passkey registration.
4. A submitted transaction with uncertain outcome must never generate a new deployment until reconciled.
5. A signed transaction's hash must be derived from its XDR, not trusted from caller input.

## Verification log
- Previous user report: TypeScript typecheck passed; 184 tests passed, 27 skipped, prior to subsequent adapter changes.
- Changes after that report are **not yet verified**.
