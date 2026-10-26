# Cherry Wallet API — Developer Portal

The wallet portal has a **public, read-only API reference**. The canonical
machine-readable document is assembled by the running Fastify API from the same
payment, payroll and invoice OpenAPI code used by the project, with identity,
deployment and integration routes added.

| Environment | Portal | OpenAPI 3.1 JSON | Base API |
| --- | --- | --- | --- |
| Hosted wallet, once this release is deployed | `https://wallet.cherrymoney.co.uk/developers` | `https://wallet.cherrymoney.co.uk/api/v1/openapi.json` | `https://wallet.cherrymoney.co.uk/api/v1` |
| Local Vite with API proxy | `http://localhost:5174/developers` | `http://localhost:5174/api/v1/openapi.json` | `http://localhost:5174/api/v1` |

The alternate frontend route `/api-docs` displays the same reference. The
web reverse proxy already forwards `/api/` to the Fastify container. Both
routes require the matching API and frontend release to be deployed; URL
construction does not prove live availability.

## What is documented

- **Authentication:** email-first WebAuthn onboarding, registration and
  authentication challenges, authenticated account identity and session logout.
- **Smart wallet:** capabilities, verified deployment, status and one-time
  Testnet XLM funding request. HTTP acceptance does not mean chain confirmation.
- **Payments:** owner-scoped wallet discovery, balance, verified history,
  persistent idempotent attempts, transfer-specific passkey approval, cancellation,
  status and recovery.
- **Invoices:** merchant-managed invoice QR, public checkout terms, unmatched
  receipts and explicit manual allocation. Invoice routes are delivered by the
  dependency PR #66; the new UI in #67 includes them.
- **Payroll:** saved Testnet pay runs and per-line payment approval.
- **Optional integrations:** Aurora is separate, mainnet-only when configured;
  Stellar recipient Nansen risk coverage is unsupported.

Existing `docs/payments.openapi.json` remains the CI-checked payment/payroll/
invoice subset exported by `cd apps/api && npm run schema`. The live
`/api/v1/openapi.json` extends it with account and platform endpoints, without
copying API records or secrets into the frontend.

## Authentication and safety

The OpenAPI route is intentionally public and *read only*. It does not expose
wallet sessions, approval challenges, server secrets, account data or wallet
private keys. The portal offers no Try It/send-money control.

- An owned-wallet API needs a **session bearer token** created after WebAuthn
  authentication; an email address or `walletId` is not an authorization grant.
- Mutations enforce the configured same-origin `Origin` header. Payment
  approval additionally requires a one-time challenge bound to the exact
  recipient, amount, network and maximum fee.
- Use `Idempotency-Key` on payment creation. Unknown payment outcomes must
  be checked; never create a replacement automatically.
- All Cherry smart-wallet payment, invoice and payroll flows use **Stellar
  Testnet native XLM**, with no real-world value. Never send mainnet funds.
- API endpoint visibility is not proof of activation. The portal reads the
  existing public `/health` capability booleans; these are still not receipt
  or on-chain signer evidence.
- No public machine-to-machine accounting API key or independent business role
  model is offered here. Merchant integration requires the existing owner
  session; optional webhook delivery is operator-configured.

## Verification

```sh
# API checks
cd apps/api
npm ci
npm run typecheck
npm test
npm run schema

# Web checks
cd ../web
npm ci
npm run build
npm run lint
npm test

# After deploying BOTH matching images, from an allowed environment:
curl -fsS https://wallet.cherrymoney.co.uk/api/v1/openapi.json
curl -fsS https://wallet.cherrymoney.co.uk/health
```

The API regression test verifies anonymous document access, core schemas and
authentication labels, with no secret material. Frontend tests verify an
anonymous visitor can see the API directory without entering an account, that
search/group filtering never triggers a payment and that an old API produces
an explicit unavailable state. **CI with mocked service responses is not a
live deployed-URL or signed blockchain-transfer test.**
