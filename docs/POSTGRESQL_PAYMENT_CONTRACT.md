# PostgreSQL payment repository — persistence contract

Source: `apps/api/src/payments/postgres-repository.ts` and `apps/api/migrations/002_wallet_payments.sql`. Sunil maintains the database and identity integration. The payment service/HTTP boundary remain dormant until B1/B2 Testnet contracts, real on-chain policy/backup recovery and transfer-bound approval pass security review.

## PostgreSQL application tables

- `wallet_onchain_accounts`: deployed, owner-scoped Testnet smart wallet records; no public provisioning endpoint.
- `wallet_payment_attempts`: immutable intent/amount hash, owner wallet, idempotency key, signed-XDR/tx hash, exact statuses, fenced worker leases; unique `(wallet_id,idempotency_key)`.
- `wallet_relayer_locks`: exclusive **per-relayer** unresolved-attempt reservation. Do not replace with check-then-insert.
- `wallet_transfer_events`: immutable canonical on-chain event identity; collisions on changed payload abort the transaction.
- `wallet_balance_snapshots`: exact numeric stroops; rejects stale-ledger overwrites.
- `wallet_monitor_cursors`: database-locked opaque RPC cursor; dedupe and cursor advance commit atomically.
- `wallet_accounts`, `wallet_credentials`, `wallet_challenges`, `wallet_sessions`: verified WebAuthn storage, unique credentials, expiring one-time challenges and hashed bearer sessions.

All database changes use PostgreSQL transactions and placeholders. Numeric stroops are exact decimal strings in the JS boundary; PostgreSQL uses `NUMERIC(20,0)` for values and `BIGINT` for ledgers/timestamps. Avoid JavaScript floating-point arithmetic for amounts.

## Critical PaymentRepository guarantees

- `wallet(id,owner)` scopes reads to the authenticated account; a caller-supplied wallet ID is not an authorization grant.
- `create` locks the global relayer reservation, returns the same attempt for a duplicate idempotency key, and rejects a second unresolved payment. Different intents with the same key conflict.
- `claim` acquires a row-level transaction lock, checks status + lease expiry, and creates an unpredictable fencing token.
- `checkpoint` durably stores signed-intent state **before** any potentially external RPC effect without releasing the lease.
- `finish` checks the lease token and immutable attempt transitions; event insert/verification and relayer release occur in the **same transaction**. Unknown/pending attempts continue holding the reservation.
- `ingest` locks the cursor and commits all events plus the cursor atomically, rejecting event collisions and stale cursor writes.
- `setBalance` only permits balances from a newer or equal ledger.
- Every method resolves only after database COMMIT, and no DB transaction spans any Stellar RPC call.

## Remaining security & integration requirements

The default API registers payment routes with **503 PAYMENT_INTEGRATION_NOT_CONFIGURED**; no fake signer, payment identity, or automatic wallet deployment. A future B1/B2-reviewed composition root must inject the trusted `PostgresPaymentRepository`, verified `PolicyReader`, restricted fee sponsor and authenticated wallet subject into `createPaymentRuntime` and `registerPaymentRoutes`.

CI tests cover database-backed claims, replay protections, idempotency, cursor collisions and ledger monotonicity. Full Testnet smart-account WebAuthn/relayer E2E remains a separate mandatory gate.

The Stellar Wallet Backend indexer lives outside this application's tables: its GraphQL outputs may enrich UI balances/history after parity checks, but **never determine spending authorization**.
