# Email, passkey, C-wallet and Testnet allocation

The default UI accepts an email and calls `POST /api/v1/passkeys/onboarding/options`
with `{email}`. The API normalizes the email and selects authentication if a
credential exists, or initial registration otherwise. An interrupted enrollment
reuses the stored WebAuthn user handle. Registration completion locks the account
and refuses a second initial credential. A missing device credential or cancelled
login never falls back to replacing an existing credential.

The browser must ask for the device's passkey confirmation. Email is an account
identifier; this flow does not verify mailbox ownership. Session credentials stay
in memory. The consumer UI is email-first and does not offer legacy UUID login. Legacy UUID records and backend authentication compatibility remain separate from the new-email onboarding flow.

After verified registration or login, the UI queues or resumes the user's
passkey-controlled C-address deployment. It displays an address only after the
worker verifies the committed deployment and current primary signer binding.
There is no user G-wallet or user Stellar secret seed.

Once the C-wallet is verified, the UI offers **Fund Testnet wallet**. The
session-authenticated `POST /api/v1/smart-account/funding` accepts only an empty
object. The server obtains the recipient from that owner's verified deployment.
It requests exactly **10,000 Testnet XLM (100000000000 stroops)** from Stellar
Friendbot directly to the C-address, once per owner and wallet. Repeated clicks
return the saved request. The receipt describes the allocation, not the wallet's
current balance after spending. No user G-account or treasury secret is needed.

## Runtime configuration

Funding is available when automatic deployment is configured and passes its
Testnet preflight. Set `WALLET_TESTNET_FUNDING_ENABLED=false` to pause the funding
service; it defaults to true. `compose.activation.yaml` exposes this switch.
The previous `STELLAR_TESTNET_FAUCET_SECRET` is no longer used for new grants.

The fixed provider is https://friendbot.stellar.org/. Stellar documents direct
C-address support and its 10,000 XLM Testnet allocation at
https://developers.stellar.org/docs/networks. Friendbot is rate limited and its
availability is external to Cherry Pay. Never request extra accounts or repeated
grants to manufacture a larger allocation. Test tokens have no monetary value.

`WALLET_DEPLOYMENT_PILOT_LIMIT` defaults to `0` (no owner-count cap); operators may
set a cap from 1 to 1000. Deployment remains opt-in with
`WALLET_DEPLOYMENTS_ENABLED=true`. Existing fee caps remain enforced. Public
onboarding permits multiple email identifiers; one allocation per wallet is not
one allocation per human, nor proof of mailbox ownership.

## Reconciliation and operation

Migration 012 stores the verified C-recipient, exact amount, starting ledger,
request state and receipt hash in PostgreSQL. A cross-process advisory lock
serializes the worker. The SUBMITTED checkpoint is committed **before** making
one HTTP request. A returned hash is committed before RPC verification. After a
restart, the worker reconciles that same hash without requesting another grant.

A timeout, missing provider hash, changed response format, or crash around the
HTTP call enters `REVIEW_REQUIRED`. Friendbot offers no client idempotency key,
so the worker must not automatically repeat an uncertain request. The UI shows
operator review instead of success or a retry button. Preserve the row and
request timestamp. An operator must locate the provider transaction for that
request and verify its Testnet native SAC recipient, amount and ledger before
attaching the receipt hash and resuming reconciliation. If no receipt can be
established, leave the outcome unresolved; a positive balance alone is not proof.
A confirmed failed transaction is terminal. Unknown RPC outcomes remain pending.

Only independently verified successful native SAC transfers of exactly 10,000
XLM to the saved C-address, committed after the starting ledger, become FUNDED.
HTTP success, indexer data and balance alone are insufficient. Polling is fair
across owners so one unresolved request does not block another user's grant.

Migration 011 and its old treasury envelopes are preserved unchanged. Existing
legacy grants block a second grant; confirmed historical receipts retain their
original amount, while unresolved legacy jobs require operator reconciliation.
The old treasury worker is no longer configured. Resolve legacy transactions
before any rollback to an older release; do not run old and new funding workers
concurrently. Do not remove migration 012 from a database where it has run.

Primary deployment and inbound Testnet funding do not enable spending or certify
independent backup recovery. Existing activation and recovery checks still apply.

## Validation boundary

Unit tests cover the fixed endpoint, Testnet/C-recipient checks, exact receipt
verification, unavailable/changed provider responses, authenticated routes and
UI states. PostgreSQL integration tests cover duplicate requests, durable HTTP
checkpoints, restart reconciliation, concurrent workers and historical grants
with synthetic evidence. A live Friendbot grant and independently verified RPC
receipt are separate acceptance evidence; mocked tests do not prove them.

## Wallet app profile and onboarding acceptance (PR #56)

The active account session is owned by `PaymentConnection` for the lifetime of the
wallet application. The `/profile` route is now an independent `Profile`
component consuming a read-only account snapshot and explicitly permitted
actions through `WalletAccountContext`. The context **never contains the bearer
session token**. Route changes do not remount the session controller. Neither
profile information nor a verified C-address may be rendered for an unauthenticated
session.

The profile includes the email/account ID (read-only), registered sign-in passkey
count, separated wallet status, a masked verified C-address with Show/Hide and
Copy, funding state and appropriately gated funding action, independent signer
recovery warnings and sign-out. Adding a sign-in credential does not silently
create an on-chain backup signer. Payment authorization is not implemented by
the profile page.

### Automated checks

Run `cd apps/web && npm ci && npm run build && npm run lint && npm test`.
The GitHub Actions **Payment frontend checks** workflow executes these steps.
`wallet-journey.test.tsx` covers the complete **frontend** registration and
returning-user route flow using mocked backend/WebAuthn APIs, including
profile navigation without another login, account visibility, address masking,
deployment unavailable state and session logout.
`Profile.test.tsx` separately covers private fields, funding disabled before
verified deployment, copy/reveal controls and available profile actions.
Existing connection/deployment, balance, send, receive and API tests remain
regression gates. **Mock-backed frontend tests are not live blockchain E2E
acceptance.**

### Required live staging acceptance before enabling new users

Use two separate email identities and independently controlled passkeys on
Stellar Testnet, with no reused profile, wallet or browser session.
Record redacted pass/fail evidence and verified hashes/ledger numbers:

1. Register A. Verify email is the account ID, passkey confirmation is requested,
   and a C-wallet is not shown before on-chain signer/deployment confirmation.
2. Refresh during pending deployment; confirm status is recoverable after a reload,
   without a duplicate deploy or a new wallet/address.
3. Confirm deployment and payer-specific funding for A; ensure the single Testnet
   grant has a verified receipt and the indexed balance updates.
4. Navigate Dashboard → Profile → Send → Receive → Profile without another
   authentication until expiry. Verify masks and copies the *same* owned C-address;
   ensure a foreign user's wallet is never shown.
5. Add a second sign-in passkey, then verify it **does not** claim on-chain backup
   recovery and does not silently authorize payments.
6. Register B independently, receive supported native-XLM SAC Testnet transfer
   from A, approve on A's primary passkey, confirm the exact hash and transfer
   event, and verify A/B balances and histories independently.
7. Exercise cancelled passkey approval, uncertain/failed send recovery and
   duplicate idempotency requests without creating another payment.
8. Sign out on both devices; confirm bearer revocation, no authenticated profile
   details, and a fresh passkey challenge before returning.
9. Test narrow viewport, keyboard-only focus order, error states and screen reader
   labels for the profile and onboarding steps.

Actual authenticator and Stellar RPC receipt evidence must be recorded
separately from CI. Do not label a staging exercise complete without those
observations; Testnet assets have no monetary value.
