# PostgreSQL 17 application database — implementation and adoption status

## Confirmed constraint

Cherry Pay has **no existing MySQL data**. This is a clean database replacement. No database export/import, backfill, dual-write, rollback-data copy or conversion pipeline is needed.

## Implemented on PR #16

- Replaced `mysql2` with `pg`, updated package lock and Docker image.
- Added PostgreSQL 17 Compose service/healthcheck and private named volume.
- Added versioned, checksum-verified and transactional SQL migrations for identity, sessions, deployed-wallet records, payment attempts, fenced leases, relayer reservations, indexed events, balances and cursors.
- Ported passkey credential/challenge/session persistence to PostgreSQL transactions, row locks and one-time challenge consumption.
- Added `PostgresPaymentRepository` implementing the B3–B7 asynchronous persistence contract. It is **not wired to enable spending** until on-chain B1/B2 security gates pass.
- Added PostgreSQL integration tests to the API CI service.
- Retained the existing Stellar Testnet RPC, signed-XDR checkpointing and transfer verification logic.

The app owns `wallet_*` tables in a dedicated PostgreSQL database. **Never write directly to Stellar Wallet Backend's separate PostgreSQL/TimescaleDB tables.**

## Remaining gates

1. CI must confirm typecheck, unit tests, PostgreSQL-backed integration tests and repeatable migration startup.
2. Manual Docker startup, WebAuthn browser acceptance, parallel registration, timeout recovery and PostgreSQL restart/persistence checks.
3. Independently verify signer contract B1, transfer-bound WebAuthn approval B2, backup/recovery, policy reader and actual C->G Testnet XLM transfer. No runtime payment adapter is enabled yet.
4. Evaluate [Stellar Wallet Backend](STELLAR_WALLET_BACKEND.md) as an **optional read-only indexing API**. Its `main` branch presently describes unreleased functionality; pin and test a published release before production reliance.
5. Document operations: secrets, TLS, database connection limits, retention, backups/restore and alerting.

## Separation of concerns

- **App PostgreSQL:** wallet ownership, passkeys, sessions, transfer authorizations, idempotency, durable attempts, fencing and monitor cursors. PostgreSQL 17 is sufficient; no TimescaleDB extension is needed.
- **Stellar Wallet Backend:** GraphQL balances/history, indexed from Stellar RPC; independent PostgreSQL 17 + TimescaleDB 2.28+ (per upstream `main` docs, subject to release requirements).
- **Security:** an indexed balance or successful WebAuthn login **does not grant transfer authorization**. Keep independently verified event matching before marking payment attempts as confirmed.

No data migration was performed or required.
