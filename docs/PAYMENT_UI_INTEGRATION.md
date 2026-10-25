# Authenticated payment UI integration

The frontend now connects existing accounts using the API's WebAuthn authentication
options/verify flow. Account ID and deployed wallet ID are public identifiers, not
credentials. They must come from B1/B2 onboarding; a watch-only address never grants
spending authority. Session bearer tokens stay in memory and are revoked on logout.
Refresh requires signing in again. Public pending-attempt keys remain in localStorage
so signing in again can recover a previous payment.

## API adapter

`connectPaymentAdapter(apiClient(() => sessionToken), walletId, signer?)` loads the
wallet from `/api/v1/wallets/:walletId`, validates Testnet identity and outbound route
policy, and returns a `PaymentAdapter`. Every request uses same-origin `/api/v1`
URLs, no redirects, no cache and a 20-second timeout. Writes are never automatically
retried. Non-2xx responses do not become successful or empty records.

- Balance comes from the indexed balance endpoint, with its ledger shown. Preview
  review requires a snapshot updated within 60 seconds; missing/stale balance blocks
  approval. The backend independently checks balance and current policy.
- Preparing a fee preview creates a durable API attempt. The UI saves its idempotency
  key **before** that POST. The request uses a 1 XLM maximum sponsor fee; the actual
  simulated sponsor fee must be reviewed before approval. No fee is deducted from
  the wallet by this UI. The review uses integer stroops throughout.
- `createAttempt` looks up the same key rather than creating another attempt.
  Approval re-reads the persisted attempt and verifies source, destination, amount,
  fee and expiry against the reviewed quote before invoking the signer.
- A timeout keeps the recovery lock. Status lookup never submits. An unsigned attempt
  can be reviewed again or cancelled through the server; editing a preview first
  requires confirmed cancellation. Only terminal outcomes release the UI lock.
- Payment attempts and independently verified indexed transfers have separate views
  and cursors. Incoming events are not fabricated attempts. Event identity and
  wallet membership are checked. Indexed transfer fees are unavailable, not assumed
  zero. Receipt links are generated locally for verified Testnet hashes; API URLs
  are never rendered as receipt links.

## B1/B2 handoff

`<App signer={signer} />` accepts a trusted `TransferSigner`. It receives the exact
persisted attempt ID, wallet ID, intent, fee, authorization XDR, expiration ledger
and expiry. It must validate and sign that Soroban authorization using the deployed
contract's passkey format and return signed authorization XDR. A generic login
assertion must never be substituted. The server still enforces authorization binding.
No default signer or fabricated contract policy is included. Sending stays disabled
without this adapter; default backend payment routes also remain gated.

The current wallet endpoint does not expose a receive route. The adapter therefore
does not infer one from outgoing `supportedDestinations`. Once B1/B2 validates funding,
the endpoint may return `receive: { address, route: 'contract' | 'classic', instructions }`.
The adapter validates address/route equality before exposing QR/copy instructions.
Until then the receive screen remains explicitly unavailable. Initial registration,
contract deployment, wallet discovery and backup recovery remain Sunil's B1/B2 work.

Existing integrations can still supply `<App paymentAdapter={adapter} />` directly;
that suppresses the built-in connection form.

## Running and verification

Run `npm ci`, `npm run build`, `npm run lint`, `npm test` in `apps/web`.
Vite proxies `/api` to `http://127.0.0.1:3001`; Docker Compose sets
`WALLET_API_PROXY_TARGET=http://api:3001`. The proxy preserves the browser Origin.
Set backend `WALLET_ORIGIN` to the exact browser origin (local Vite normally
`http://localhost:5173`, Compose normally `http://localhost:5174`). Production hosting
must route same-origin `/api` to the API; do not embed secrets or API bearer tokens
in Vite environment variables.

Frontend CI checks build, lint and tests. Tests cover precision, response validation,
verified receipts, passkey-session connection/logout, missing signer, recovery keys
before preparation, timeout recovery, preview mutation and rejected signing.
A real browser/Testnet create → recover → receive → send → verify acceptance run is
still required after the B1/B2 adapter and receive metadata are supplied. No live
transfer or contract deployment is claimed by these adapter tests.
