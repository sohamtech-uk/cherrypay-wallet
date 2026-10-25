# Authenticated payment UI integration

The frontend supports initial passkey registration, existing-profile authentication
and session-bound additional-passkey enrollment. Account IDs are public identifiers,
not credentials. A new account ID is saved in localStorage before the passkey prompt,
so a lost verification response can be recovered by reconnecting with that ID.
Only public account IDs and pending-attempt keys are stored there. Session bearer
tokens stay in memory and are revoked on logout; refresh requires signing in again.
Storage/clipboard failures leave a selectable account ID and manual-copy instructions.

Registration requests and verification both allow only ES256/P-256, matching the
selected Stellar verifier. Additional enrollment replaces the browser session and
revokes its previous token. Late verification/metadata responses cannot restore a
disconnected or expired session. Cancellation before backup verification leaves
the original session usable; an uncertain verification requires reconnecting.
Enrolled credential count is a sign-in capability, never proof of on-chain recovery.

The connected overview uses indexed balance and verified history APIs, exact
integer-stroop formatting, ledger/time metadata, a balance age warning and refresh.
Balance and activity failures are independent. Missing data is not a zero balance.
Classic watch-only lookup is separate and validates StrKey checksums; it never
connects a spending wallet or displays smart-account ownership.

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

Initial registration creates an identity profile, not a deployed smart account.
The pilot operator must supply accepted deployment and independent recovery evidence,
configure the pinned runtime, and link the owned wallet using the trusted provisioning
CLI. See [Testnet startup](TESTNET_STARTUP.md). The browser discovers owned wallet IDs
through authenticated `/api/v1/wallets`; users do not enter a wallet ID manually.

Configured wallet metadata advertises `approvalMode: 'webauthn'`, enabling the
server-mediated approval flow below. A separately verified integration can still
supply `<App signer={signer} />`; its exact Soroban authorization must bind the
persisted intent, fee and expiration. A login assertion is not payment approval.
The browser always prefers advertised WebAuthn approval over an injected signer.

Receive instructions require explicit `receive: { address, route, instructions }`
metadata from the verified receive-route provider. Outbound destination support is
not funding evidence. Additional profile enrollment neither installs an on-chain
signer nor executes a recovery/rotation ceremony; those acceptance steps remain open.

Existing integrations can supply `<App paymentAdapter={adapter} />` directly;
that suppresses the built-in profile panel.

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
still required after approved deployment configuration is supplied. No live
transfer or contract deployment is claimed by these adapter tests.


## Server-mediated passkey approval

When trusted startup supplies `passkeyCodec`, wallet metadata advertises
`approvalMode: 'webauthn'`. The adapter calls `/attempts/:id/approval/options`, checks
the returned persisted intent and expiry against the review, requests WebAuthn with
user verification, then posts `{ requestID, response }` to `/approval/verify`.
The API verifies the assertion against its one-use session-bound ticket before
contract encoding and enforced simulation. Injected external signers remain
supported for a separately verified B1/B2 integration.

The backend can supply `receiveRoute: verifiedReceiveRoutes(...)` after approved
contract and recovery evidence is recorded. No route is inferred from outbound
support. See [workshop status](WORKSHOP_PHASE_STATUS.md) for the actual remaining
live gates and the legacy artifact that must not be deployed.
