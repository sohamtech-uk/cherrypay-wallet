# PostgreSQL migration and Stellar Wallet Backend adoption

Status: **Migration plan only.** No database engine, runtime, schema, or payment behavior is switched by this document. Keep payment submission disabled until security gates pass.

## Why

Stellar [wallet-backend](https://github.com/stellar/wallet-backend) uses PostgreSQL with TimescaleDB to index balances, transfers, transactions, and operations and expose them through GraphQL. We are standardizing the Cherry Pay *application* database on PostgreSQL to simplify operations, while keeping wallet-backend in a separate, vendor-managed database and avoiding direct writes to its tables.

**Version pin required before deployment:** As checked on 2026-10-25, wallet-backend's main-branch README describes PostgreSQL 17 with TimescaleDB 2.28+ and Stellar RPC 28.x/29.x. Main documentation may describe unreleased features; select a released wallet-backend tag, follow its version-specific deployment instructions, and lock tested database/extension/RPC versions.

## Ownership and architecture

- **Cherry Pay API** (Node.js): identity, passkey WebAuthn credentials and one-time challenges, hashed sessions, wallet ownership, approval policies, payment attempts, idempotency, signed-intent checkpoints, worker leases and business transactions.
- **App PostgreSQL DB**: durable application tables; migrations owned by Sunil.
- **Wallet Backend**: separately deployed/indexed service with its own PostgreSQL/TimescaleDB database and GraphQL API; *read-only from Cherry Pay*.
- **Stellar RPC + chain reconciliation**: maintain independently verified transfer confirmation. Wallet Backend's indexer/GraphQL should serve balances and history once backfilled and validated. Do not mistake an indexed record for successful authorization or skip exact native-XLM-SAC event verification.
- **Relayer**: constrained to an approved, immutable authorization envelope; no mainnet keys in agents or code.
- **Frontend**: existing A4–A7 adapter and accessibility flow; implement verified backend integration only after safe session + transfer-bound signing approval.

## Migration deliverables

1. Freeze and back up any existing MySQL data; inventory tables, row counts, and foreign keys. Do not destroy MySQL or change existing environments in-place. Confirm whether there are real user records.
2. Add a PostgreSQL migration framework with checksums/versioning and transaction boundaries. The current `apps/api/sql/001_wallet_schema.sql` is MySQL DDL and must be ported, not executed against PostgreSQL. Port accounts, credentials, challenges, sessions, and eventual payment tables with explicit unique indexes/FKs and replay protection. Test repeat migrations and rollback/recovery.
3. Replace `mysql2/promise` in `apps/api/src/store.ts` with parameterized `pg` queries and pooled connections. Port `?` parameters to `$1`, `<=>` null matching to `IS NOT DISTINCT FROM`, `DATE_ADD` and `UTC_TIMESTAMP` to timezone-aware PostgreSQL expressions, and MySQL result headers to `rowCount`. Preserve `SELECT ... FOR UPDATE`, short transactions and atomic credential counter/one-time challenge operations. Verify UTC expiry semantics and do not expose raw bearer tokens in logs.
4. Update `apps/api/package.json` and lockfile, API Dockerfile, env examples, Compose DB service/volume and readiness healthchecks. Remove MySQL-only bootstrap SQL/runtime dependencies only after tests pass. Never ship default credentials; use secrets outside git.
5. Implement the `PaymentRepository` contract in PostgreSQL as a separate tested adapter, retaining signed-XDR immutability, serializing a single unresolved relayer reservation, idempotency-key uniqueness, fencing-token compare-and-swap updates, durable monitor cursors and event deduplication. Refactor `docs/MYSQL_PAYMENT_CONTRACT.md` into a PostgreSQL-specific contract after implementation. Never hold SQL locks while invoking RPC.
6. Implement an explicit, read-only Wallet Backend GraphQL client or adapter, mapping verified address/asset balances and transaction history without importing vendor DB tables. Track indexing lag, cursor/reorg/replay semantics and RPC retention gaps; avoid double ingesting the same transfer. Keep existing RPC verification logic authoritative for confirmation until test fixtures establish parity.
7. If production/staging MySQL data exists, build a repeatable export/import mapping preserving credential bytes/base64, case-sensitive identifiers, hashes, timestamps and integer stroops exactly. Validate row counts and referential integrity. Dual-write is **not** presumed safe; plan downtime or a validated change-data-capture strategy. Preserve rollback ability.
8. CI acceptance: PostgreSQL service container and integration tests; typecheck, unit tests, true DB concurrency tests, passkey registration/authentication/recovery, idempotency collisions, parallel sessions, transfer-bound authorization mutation/replay, RPC timeout and restart recovery, indexer cursor collision, stale balance prevention, migrations and backup/restore.
9. Testnet acceptance: create/recover wallet; C->G XLM SAC send with constrained relayer; independently verify the transfer; show indexed balance/history and receipt only after verified. Do not enable mainnet or deploy smart accounts before B1/B2 security review.

## Existing files requiring edits

- `apps/api/src/store.ts` — MySQL driver and SQL dialect.
- `apps/api/sql/001_wallet_schema.sql` — MySQL-only schema.
- `apps/api/package.json`, `apps/api/package-lock.json`, `apps/api/Dockerfile` — dependencies/build.
- `compose.yaml` and `.env.example` — database wiring.
- `docs/MYSQL_PAYMENT_CONTRACT.md` — payment repository handoff.
- `docs/P0_IMPLEMENTATION_STATUS.md`, `apps/api/README.md` — status and operational documentation.
- `apps/api/src/payments/*` — preserve current API and source verification; inject a PostgreSQL persistence adapter rather than rewriting payment logic.

## Stop/go gates

- **Do not flip DB config** until PostgreSQL schema migration, passkey/session tests, and payment repository integration pass.
- **Do not delete MySQL data** until explicit backup/restore and migration reconciliation succeed.
- **Do not treat Wallet Backend as transaction authorization**; RPC and on-chain signer policy remain separate payment safety controls.
- **Do not couple app migrations to wallet-backend internal tables**; wallet-backend upgrades must use its published migration procedure.
