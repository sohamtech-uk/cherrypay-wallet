# Stellar Wallet Backend — optional Testnet indexer

Upstream: https://github.com/stellar/wallet-backend

As of 25 October 2026, the project's `main` branch describes a wallet GraphQL indexer with PostgreSQL 17 + TimescaleDB 2.28+ and Stellar RPC 28/29. **The releases API showed no published releases at the time of review**, and the README warns that `main` may describe unreleased functionality. Do not treat the example `v1.0.0` tag in upstream docs as a release until GitHub actually publishes it.

## Local evaluation (independent from Cherry Pay Compose)

```sh
git clone https://github.com/stellar/wallet-backend.git
cd wallet-backend
docker compose up
```

This uses the *upstream project's own* Compose stack with a separate TimescaleDB, Stellar Testnet RPC, migrator, ingest worker and GraphQL API. It can use significant disk/CPU while backfilling. Do not run alongside production services without sizing and monitoring.

The upstream testnet guide advertises:

- Health: `http://localhost:8002/health`
- GraphQL: `http://localhost:8001/graphql/query`
- Account query root: `accountByAddress(address: String!)` with `balances`, `transactions` and cursor pagination.
- Hosted API authentication: where `CLIENT_AUTH_PUBLIC_KEYS` is configured, follow upstream request-signing docs, not a generic static API token.

## Existing optional GraphQL client

`apps/api/src/indexing/wallet-backend.ts` contains a **read-only**, opt-in GraphQL adapter with exact XLM decimal-to-stroops conversion, bounded queries and address validation; unit tests are in `wallet-backend.test.ts`. It is deliberately not exposed via HTTP or used to mark transactions verified. Do not connect it to the live wallet flow until a tested upstream release and data-parity check are available.

## Cherry Pay integration contract

1. Deploy upstream Wallet Backend separately; do **not** point it at the Cherry Pay application database.
2. Introduce only a bounded, read-only GraphQL client from the Cherry Pay server; never trust caller-supplied GraphQL or query arbitrary addresses without wallet owner checks.
3. Use exact decimal-to-stroops conversion for native XLM. Preserve opaque GraphQL cursors and show indexing-lag/availability separately from chain-confirmation status.
4. Compare indexer balances/history with the existing independent Stellar RPC verification for known Testnet transactions and verify backfill correctness.
5. Do not replace our application's idempotency, authorization, relayer fences, signed-XDR persistence or event identity checks.
6. Wait for a supported upstream release and pin container tags/DB-extension/RPC compatibility before enabling on the payment path.

Reference: https://github.com/stellar/wallet-backend/blob/main/docs/api/graphql.md
