# Cherry Pay Wallet — local PostgreSQL 17 development

Prerequisites: Docker with Compose v2. **No existing database contents need migrating**; this is a clean PostgreSQL replacement.

From repository root:

```sh
cp .env.example .env
# Edit DB_PASSWORD in .env before starting.
docker compose up --build -d
docker compose ps
docker compose logs -f api db
```

- Web UI: http://localhost:5174
- API health: http://localhost:3001/health
- API network: http://localhost:3001/api/v1/network
- DB: internal Compose service `db:5432`, **no host port published**.
- SQL migrations: `apps/api/migrations/001_wallet_identity.sql` and `002_wallet_payments.sql`, applied transactionally on API startup with a checksum and PostgreSQL advisory lock.

Run API checks using `docker compose exec api npm run typecheck`, `docker compose exec api npm test` and web checks with `docker compose exec web npm test` or `npm run build`. CI runs PostgreSQL-backed integration tests (with `RUN_DB_INTEGRATION=1`).

Stop with `docker compose down`. To remove **only the new local PostgreSQL volume**, run `docker compose down -v` (permanently deletes database contents; don't use if you have data you want to retain).

Browser WebAuthn requires `localhost` to match `WEBAUTHN_RP_ID=localhost`. Avoid `127.0.0.1` for browser access. Wallet deployment, smart-contract signing and payment routes remain disabled until verified B1/B2 adapters are provided. PostgreSQL persistence does not by itself authorize on-chain spending.

For optional Stellar indexer research, follow [STELLAR_WALLET_BACKEND.md](STELLAR_WALLET_BACKEND.md). Its independent database/TimescaleDB lifecycle is **not** part of this Compose setup.
