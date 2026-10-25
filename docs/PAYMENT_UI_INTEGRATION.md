# A4–A7 payment UI handoff

Sunil is working on B1–B2 (smart-account/SDK feasibility, passkey authorization, wallet discovery and independent recovery). This branch implements the A4–A7 frontend screens on the existing `feat/wallet-ui` scaffold (c55d0ca). It does not implement B1–B2 or extend A1–A3 onboarding and balance features. App.tsx changes are route/navigation registration and an optional provider prop. No backend endpoint is assumed or invented.

## Connecting the screens

Pass a stable authenticated `PaymentAdapter` to `<App paymentAdapter={adapter} />`. The interface lives in `apps/web/src/payments/model.ts`; keep it frontend-local until the joint API contract is agreed. With no adapter, the routes display actionable unavailable states; watch-only session storage is deliberately not treated as spending authority. The app never generates signing keys or stores signing material.

- `/receive`: backend-confirmed receive address and route, instructions, local address-only QR, clipboard and manual-copy fallback. No unverified contract funding route is offered.
- `/send`: checksum validation, supported destination policy, exact integer stroops, quote, fee payer, spendable balance, review/approval, persistent attempt recovery.
- `/history`: persistent received/sent attempts, pagination, empty/loading/error states.
- `/history/:attemptId`: full transfer details and a hardcoded Testnet explorer receipt only for independently verified confirmed transactions with a valid hash.

## Backend requirements (B3–B6, not implemented here)

1. Network must be TESTNET. Authenticate wallet ownership server-side for every call. Reject unsupported routes and memo-required destinations server-side; the MVP UI does not support memos.
2. `prepare` returns a quote bound to source, recipient, exact stroops, fee, payer, spendable balance (after reserves) and expiry. Never use float arithmetic. Validate all responses in the adapter before returning typed data.
3. `createAttempt` durably persists the exact quote before approval, is idempotent for the supplied key, and enforces one unresolved submission per wallet across devices/tabs. Browser locks are UX aids, not a server security boundary.
4. `approve` must obtain transfer-bound passkey authorization, enforce quote expiry/fee limits, submit at most once and return the persisted attempt. A generic login assertion is insufficient. Rejected approval should return `rejected`; definitive on-chain failure returns `failed`. A timeout must never be represented as failure or confirmation.
5. `getAttemptByKey` recovers the same persisted attempt after reload/timeout; null means not yet found, not permission to resubmit. `getAttempt` and history must use immutable attempt IDs. Approval interrupted before submission remains blocked until the service resolves/cancels the existing attempt. The UI does not blindly reauthorize or resubmit.
6. Only return `confirmed` + `verified: true` after independently verifying native XLM transfer identity (source, recipient, amount, network, successful execution/event). Transaction inclusion alone is insufficient.
7. `listAttempts` returns wallet-scoped sent/received records and an opaque optional next cursor. Received attempts may have another source but must target the active wallet.
8. Keep adapter identity stable during a session; replace it on wallet/authentication changes. Never expose a mainnet adapter.

The browser stores only a public pending idempotency key under a wallet/network-scoped localStorage key, before any mutating call. Storage unavailable blocks submission. Clearing storage or using another device must not circumvent backend recovery/idempotency enforcement.

## Verification

From `apps/web`: `npm ci`, `npm run build`, `npm run lint`, `npm test`.
Tests cover amount precision/overflow, checksums, route gating, quote binding/expiry, insufficient funds, sponsor fees, receipt gating, unavailable services, supported QR, clipboard denial, keyboard navigation, duplicate clicks and reload after submission timeout, and history retry.

Manual integration gate before marking A4–A7 fully complete: demonstrate real Testnet receive → quote → transfer-bound passkey approval → verified history/receipt with Contributor B; exercise rejected signing, pending/unknown status, service outage, insufficient funds, recovery after browser restart and two-device duplicate submission. Verify screen-reader announcements and narrow-screen layout with the actual integrated data. No live transfer or backend E2E is claimed by this frontend PR.

Rollback: revert the payment UI commit; no data migrations, deployments or backend writes are included.
