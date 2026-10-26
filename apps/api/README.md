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

Payments default to **503 PAYMENT_INTEGRATION_NOT_CONFIGURED**. For automatically deployed wallets, the separate opt-in `WALLET_PRIMARY_PAYMENTS_ENABLED=true` mode verifies the deployed primary passkey and activates send/receive without a manifest; see [primary Testnet payments](../../docs/PRIMARY_TESTNET_PAYMENTS.md). This mode requires a dedicated funded relayer and never claims backup recovery. The normal server can now load a reviewed deployment manifest through `WALLET_PAYMENT_MANIFEST` when `WALLET_PAYMENTS_ENABLED=true`, validate the dedicated `STELLAR_RELAYER_SECRET` identity and saved wallet policy, then enable the verified runtime. Missing or invalid configuration fails startup. PostgreSQL data or a WebAuthn login session alone is not on-chain spending permission.

Use the operator-only `npm run wallet:provision -- --check` / `--apply` commands for already deployed and recovered accounts. They do not deploy contracts or change existing owner/policy bindings. See [TESTNET_STARTUP.md](../../docs/TESTNET_STARTUP.md) for the manifest format, Compose override, prerequisites and acceptance procedure. Authenticated `GET /api/v1/wallets` discovers only the session owner's wallets. WebAuthn mode requires the begin/verify endpoints and rejects raw approval submissions.

For the persistence contract and RPC recovery guarantees, see [POSTGRESQL_PAYMENT_CONTRACT.md](../../docs/POSTGRESQL_PAYMENT_CONTRACT.md). [STELLAR_WALLET_BACKEND.md](../../docs/STELLAR_WALLET_BACKEND.md) documents the optional, separately operated GraphQL indexing service.

