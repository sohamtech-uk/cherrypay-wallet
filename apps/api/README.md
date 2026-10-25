# Cherry Pay Wallet API — PostgreSQL + Stellar Testnet

The API persists passkeys, accounts, challenges and sessions in **PostgreSQL 17**, applying transactional, checksum-verified migrations on startup (`src/migrations.ts`, `migrations/`). A separate `PostgresPaymentRepository` implements durable payment attempts and replay-safe indexing.

## Local development

From repository root copy `.env.example` to `.env`, choose a database password, then run `docker compose up --build -d`. API health at http://localhost:3001/health and frontend at http://localhost:5174. PostgreSQL is internal to Compose, not published to the host.

For CLI tests:

```sh
cd apps/api
npm ci
npm run typecheck
npm test
npm run schema
```

The CI workflow runs PostgreSQL integration tests with `RUN_DB_INTEGRATION=1` and a fresh database. Do not set this variable without a configured test database.

## Security and integration gate

The current server intentionally calls `registerPaymentRoutes(app)` without payment dependencies, so payment endpoints return **503 PAYMENT_INTEGRATION_NOT_CONFIGURED**. PostgreSQL data or a WebAuthn login session is not on-chain spending permission. Do not enable wallet deployment or payment endpoints until B1/B2 verifies smart-account artifacts, transfer-bound passkey authorization, backup signer/recovery, owner session, policy fingerprint, and constrained fee relayer. All testing is Stellar Testnet only.

For the persistence contract and RPC recovery guarantees, see [POSTGRESQL_PAYMENT_CONTRACT.md](../../docs/POSTGRESQL_PAYMENT_CONTRACT.md). [STELLAR_WALLET_BACKEND.md](../../docs/STELLAR_WALLET_BACKEND.md) documents the optional, separately operated GraphQL indexing service.
