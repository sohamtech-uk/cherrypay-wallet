# Cherry Pay Wallet

**A merchant invoice becomes a passkey-approved Stellar payment and a verifiable receipt.** Cherry Pay helps a small business request a payment by QR/link and see which invoice it settles, without asking the payer to manage a seed phrase or acquire network fees separately.

HackMeridian 2026 submission target: **Genesis — Stellar Composed**. This is a **Stellar Testnet XLM prototype**, with no real-money settlement, fiat conversion or production-readiness claim.

- [Try the wallet](https://wallet.cherrymoney.co.uk)
- [Judge guide: composition, problem, progress and demo script](docs/GENESIS_SUBMISSION.md)
- [Test plan: payment evidence, UX prize preparation and release gates](docs/JUDGE_TEST_PLAN.md)
- [Current integration branch](https://github.com/sohamtech-uk/cherrypay-wallet/tree/develop) — judge this branch; the repository's default `main` can lag behind it.

## What the MVP does

A merchant creates an exact-XLM invoice with an expiry and shares its QR or payment link. The payer sees the merchant, amount and destination, signs in with a passkey, reviews the exact amount and sponsored fee, and authorizes the persisted payment. The UI distinguishes submission, uncertainty and independently verified confirmation. A receipt is associated with the invoice through its payment-request ID and verified transfer event; equal amounts alone do not match invoices.

The implementation composes Smart Account Kit generated bindings, pinned OpenZeppelin smart-account/WebAuthn verifier contracts, and the Stellar SDK/native XLM Stellar Asset Contract. Cherry Pay adds invoice checkout, fee sponsorship, durable payment attempts and merchant reconciliation. The kit/OZ account stack is related infrastructure, not two independent integrations counted twice. See the judge guide for source paths and attribution.

## Implementation and evidence boundaries

| Area | In the repository | What still needs live acceptance evidence |
| --- | --- | --- |
| Passkey identity and automatic Testnet account deployment | Email/passkey onboarding, pinned account/verifier checks and deployment worker | Physical device ceremony and deployed wallet evidence for the recorded demo |
| Native XLM payments | Primary-passkey authorization, fee-only relayer, strict recipient/amount/network checks | One recorded payer-to-merchant payment with independently verified receipt |
| Payment reliability | PostgreSQL attempts, idempotency, confirmation verification, history and durable cursors | Controlled restart/network-loss rehearsal on the demo deployment |
| Invoice checkout | QR/link, immutable payment request, exact amount, receipt allocation and totals | Merchant invoice → payer approval → receipt → merchant paid state in one recording |
| UX | Mobile styles, keyboard controls, review focus, status/error announcements and recovery actions | Physical mobile, screen-reader and first-time-user testing in the test plan |
| Independent recovery | Backup credential and recovery-related code/evidence gates | Lost-primary-device exercise with independent on-chain recovery; **not verified** |

Public `/health` and `/api/v1/smart-account/capabilities` report runtime availability. They do not prove a particular wallet can spend or that a payment succeeded. Wallet-specific ownership, signer and authorization checks still apply. Primary-payment mode can be enabled while independent recovery remains unverified. The local bootstrap keeps payments disabled unless a trusted runtime is supplied.

Aurora Testnet funding remains disabled because the configured Base USDC → Stellar USDC route does not support this Testnet deployment. Nansen does not provide the Stellar assessment requested here. Neither is part of the working-demo claim. Envio is not this wallet's Stellar indexer. No anchor cash-out, confidential payroll or mainnet USDC flow is claimed.

## Developer API

[API reference](docs/DEVELOPER_API_PORTAL.md), [developer portal](https://wallet.cherrymoney.co.uk/developers), and [OpenAPI JSON](https://wallet.cherrymoney.co.uk/api/v1/openapi.json). Deploy matching API/web images before relying on a new endpoint; the read-only check below detects missing routes and stale capabilities.

```sh
node scripts/check-judge-readiness.mjs https://wallet.cherrymoney.co.uk --require-payments
```

A passing report proves only the named HTTP/configuration checks. It does not sign, fund or send, render the UI, verify the deployed commit, or replace the live test plan.

## Local setup and verification

1. Copy `.env.example` to `.env`; set a strong local `DB_PASSWORD`.
2. Run `docker compose up --build -d`.
3. Visit http://localhost:5174; API health: http://localhost:3001/health.
4. See [local Docker setup](docs/LOCAL_DOCKER.md) and [PostgreSQL implementation](docs/POSTGRESQL_WALLET_BACKEND_MIGRATION.md).

Run `npm ci`, then `npm run build && npm run lint && npm test` in `apps/web`. In `apps/api`, run `npm ci`, then `npm run typecheck && npm test && npm run schema`. PostgreSQL integration tests require the database environment configured in [API CI](.github/workflows/payment-api.yml); skipped database tests are not a pass. `bash scripts/test-production-containers.sh` checks compiled images, migrations and proxy behaviour using Docker. `node --test scripts/check-judge-readiness.test.mjs` tests the read-only checker.

The application owns its PostgreSQL 17 attempts, invoice records and monitoring cursors. Stellar SDK/RPC supplies chain reads. [Stellar Wallet Backend](docs/STELLAR_WALLET_BACKEND.md) is a separate optional indexer with separate storage; do not merge its schemas into this database.

Read [AGENTS.md](AGENTS.md), [collaboration guide](docs/COLLABORATION.md) and [Stellar ecosystem guidance](docs/STELLAR_ECOSYSTEM_GUIDE.md) before contributing. Never commit secrets or use mainnet funds for this prototype.
