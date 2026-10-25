# Aurora Intents and recipient intelligence

## Scope and reuse

`/pay-from-another-chain` implements the fixed **Base mainnet USDC → Stellar
mainnet Circle USDC** route. This is separate from the passkey wallet's native
XLM Testnet payment service and its history/ledger. The screen has an explicit
mainnet banner; it never pre-fills a Testnet wallet as the recipient.

Adapted from [Monad-Metropolis at 10d7bd3](https://github.com/sohamtech-uk/Monad-Metropolis/tree/10d7bd3052200550937704b3d19d8c5deaa02009):

- `apps/mobile/src/aurora/config.ts`: Base chain 8453 and native USDC asset ID.
- `aurora/plan.ts`: exact-input semantics, strict decimal input, 100 USDC pilot
  cap, 1% slippage and a 15-minute deadline.
- `aurora/payment.ts`: live supported-token checks before producing a quote.
- `aurora/AuroraExecutionForm.tsx`: separate mainnet flow, quote review,
  external-wallet deposit instructions, uncertain-outcome recovery.
- `nansen/client.ts` and `NansenRecipientIntelligence.tsx`: same-origin read-only
  client, explicit errors, stale-result invalidation and provider attribution.

The Monad EVM `USDC.transfer` recipe and Mera EVM signer are **not Stellar
execution mechanisms**. This integration uses the official
[Aurora Swap API](https://docs.intents.aurora.dev/intents-swap/what-is-swap-api),
which delivers the destination asset directly. Aurora supplies the routing,
deposit addresses, execution, refunds and provider status. Cherry does not run
a solver, sign a deposit, or implement a bridge.

Stellar asset ID and Circle issuer were checked against
[Aurora's widget source at 3e830c2](https://github.com/aurora-is-near/intents-swap-widget/tree/3e830c2d54af054b61e75b1384a0b6786be433ce).
Base USDC has 6 decimals; Stellar USDC has 7. Amounts remain integer strings and
`bigint` throughout; there is no floating-point currency conversion.

## Flow and boundaries

1. The user enters a personal Stellar mainnet G-address, exact Base USDC input
   and their Base refund wallet. C-addresses, muxed addresses, the issuer,
   memo-required accounts and accounts without an authorized Circle USDC
   trustline are rejected. Horizon verifies the account and receive capacity.
   The UI additionally asks the user to confirm no memo is required; not every
   exchange advertises this on-chain.
2. The server checks Aurora's live token catalog and creates an unfunded
   `EXACT_INPUT` quote. Creating a quote is not a transfer. The server key never
   leaves the API. The fixed provider URL cannot be overridden by request data.
3. The review binds the exact recipient, refund wallet, input, expected output,
   minimum output, fees and expiry. Withdrawal fees are already included in the
   quoted output and are not deducted again. The input/output difference is
   labelled as fees **and price difference**, not an invented provider fee.
   Base transfer gas is additional ETH paid by the user's funding wallet.
4. The user acknowledges the quote. A Web Lock and local recovery record are
   required before exposing the deposit instructions. A fresh matching
   `PENDING_DEPOSIT` status is required to show copy/QR controls. The QR is an
   ERC-681 **USDC transfer** URI with Base chain 8453 and atomic input, not a raw
   address that could be mistaken for a native ETH payment.
5. The user funds once in their external wallet. Cherry has no signing or
   deposit-submission endpoint. GET-only status checks poll every 5 seconds,
   stopping after 60 reads, an error or a terminal/unknown status. Manual resume
   performs status reads only. Status responses must match the reviewed quote.
6. Incomplete, failed and unknown outcomes never offer automatic top-ups,
   replacement payments or a reset. Expiry hides funding controls without
   declaring failure. Imported deposit addresses are saved as **status-only**
   records. Completion/refund labels are attributed to Aurora; explorer links
   are constructed from validated hashes, not provider-supplied URLs.

The browser stores one active swap under `cherrypay:aurora:mainnet:v1`. It contains
public quote/recovery data, not credentials. Keep the deposit address and source
receipt separately; clearing browser data loses local recovery. These records
are not PostgreSQL payment attempts, verified Stellar ledger entries, accounting
evidence or cross-device history. Independent destination-chain verification and
server-side cross-chain history remain future work. Account eligibility can
change after a quote; Aurora handles any resulting execution/refund outcome.

## Nansen AI · Recipient intelligence

`/recipient-intelligence` accepts checksum-valid Stellar G- and C-addresses and
an explicit network selection. It has no signer, funding, approval or payment
service dependency. Checks occur only on an explicit user action; typing does
not trigger requests. Editing the address/network aborts and clears old results.

As checked **2026-10-25**, Nansen's
[supported chains](https://docs.nansen.ai/reference/chains) and
[address-label API enum](https://docs.nansen.ai/api/profiler/address-labels) do
**not include Stellar**. The existing Monad proxy cannot be reused by changing
the chain string. The server returns `status: "unsupported"` and
`providerCalled: false`; it sends no address to Nansen and consumes no Nansen
credits. No risk score, identity, sanctions result or payment clearance is
fabricated. Even a valid address does not establish its network or owner.

The screen provides links to payment forms without pre-filling or authorizing a
payment. A future live Stellar integration requires documented Nansen coverage,
a server-only Nansen credential, response identity/network validation, bounded
caching/rate limits and tests for empty/partial/unavailable responses. Merely
adding a Nansen key today will not enable Stellar coverage.

## API contract

All routes return `Cache-Control: no-store` through the application hook.
POST requests require the configured wallet origin. No route accepts a provider
URL, private key, token contract, arbitrary chain or arbitrary execution recipe.

| Method and route | Request | Result |
| --- | --- | --- |
| `GET /api/v1/aurora/capabilities` | None | `enabled`, `statusAvailable`, `network: MAINNET`, fixed route and cap |
| `POST /api/v1/aurora/quotes` | `{recipient, refundTo, amount}`; decimal input string | Bound mainnet quote with integer-string `amountIn`, `amountOut`, `minAmountOut`, deposit, expiry and optional fee amounts |
| `GET /api/v1/aurora/status` | `depositAddress` query | Bound quote, provider status, checked time, validated source/destination hashes, optional actual output |
| `GET /api/v1/intelligence/recipient` | `address`, `network: MAINNET or TESTNET` | Request-bound unsupported coverage result, `providerCalled: false` |

Quote requests are limited to 5/minute/IP; status reads to 30/minute/IP. This is
a bounded per-process limiter appropriate to the current single-replica pilot.
Scale-out needs a shared limiter before increasing replicas. Provider calls have
15-second timeouts, reject redirects, and redact upstream errors (the Aurora
API key is a URL path segment). Unknown statuses remain uncertain.

## Enablement and verification

The default deployment has funding **disabled**, with no new keys or fees set.

```dotenv
AURORA_INTENTS_ENABLED=false
# AURORA_INTENTS_API_KEY=<Aurora Studio Swap API key, server only>
```

Obtain a Swap API key from [Aurora Studio](https://studio.aurora.dev/) with reviewed
fees. It is not automatically interchangeable with the existing Monad Intents
Connect proxy credential. Set it on the **API** container using an Azure secret
or Key Vault reference, not a `VITE_` variable, web image, GitHub source or browser
storage. Only set `AURORA_INTENTS_ENABLED=true` after reviewing the configured
fees and the mainnet pilot. Both values are required to request new quotes.
With the key present and the enable flag false, status recovery remains enabled.

Compose passes these environment variables to the API. The Azure bootstrap
template intentionally does not activate integrations; its deployment replaces
the template and must not be used to remove the key while swaps are outstanding.
Preserve the key/reference and availability of status recovery across releases.

Automated validation uses mocked Aurora/Horizon responses and covers route
changes, decimals, memo requirements, trustline eligibility, recipient/refund
mismatches, fee/slippage/expiry bounds, provider failures, storage failure,
cross-tab exclusion, recovery, receipt links and Nansen's read-only behavior.
Run `npm test` and `npm run typecheck` in `apps/api`, and `npm test`,
`npm run build`, `npm run lint` in `apps/web`. Existing PostgreSQL integration
tests run in CI with its database service.

No live mainnet transfer or paid Nansen lookup was performed during
implementation. Before enabling funding, verify live quoting with the deployment
key and perform a small user-approved transfer from a user-controlled Base wallet
to a user-controlled funded Stellar mainnet G-address with a Circle USDC trustline.
Record the quote, deposit receipt, provider status, Stellar receipt and actual
received amount; then verify recovery after reload and provider unavailability.
