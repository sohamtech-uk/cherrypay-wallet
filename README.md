# Cherry Pay Wallet

Customer-controlled, **Stellar Testnet-only** XLM smart-wallet MVP. Contains passkey identity/session persistence, payment preparation/reconciliation APIs, a fee-relayer implementation, wallet UI, and API tests. **Contract deployment, on-chain spending authorization, and independent recovery are not yet validated.** The default payment endpoints intentionally return 503 until secure B1/B2 adapters are supplied.

## Local setup

1. Copy `.env.example` to `.env`; set a strong local `DB_PASSWORD`.
2. Run `docker compose up --build -d`.
3. Visit http://localhost:5174; API health: http://localhost:3001/health.
4. See [local Docker setup](docs/LOCAL_DOCKER.md), [PostgreSQL DB implementation](docs/POSTGRESQL_WALLET_BACKEND_MIGRATION.md) and [Stellar Wallet Backend evaluation](docs/STELLAR_WALLET_BACKEND.md).

The application uses its own **PostgreSQL 17** database and versioned SQL migrations. Stellar Wallet Backend is a *separate optional indexer* with its own PostgreSQL/TimescaleDB storage; do not merge vendor indexer schemas into the Cherry Pay database.

**Indexing target:** this repository uses Stellar SDK/RPC event reads and persistent PostgreSQL history/cursors. Envio currently supports EVM, SVM and Fuel, not Stellar/Soroban ([supported platforms](https://docs.envio.dev/docs/HyperIndex/overview)). The separate `Monad-Metropolis` Envio deployment is not this wallet's indexer. Connecting this repository to Envio does not provide Stellar Testnet support; no Envio deployment is required for this application.

Never commit secrets, expose production signing keys to AI agents, or use mainnet funds. No real wallet payment is enabled until contract/policy/recovery security gates pass.
