# Invoice QR payments and reconciliation

Stellar Testnet native XLM only. These test receipts must never settle a real
GBP invoice. No conversion rate or stablecoin support is implied.

## Merchant and payer flow

Open **Invoices** with an authenticated, supported C-wallet. Enter the merchant
display name, invoice reference, exact Testnet XLM amount and expiry (UTC, up to
90 days). The backend chooses the receiving address from the owned wallet and
pins the native XLM SAC. Each `(walletId, invoiceReference)` is immutable and
unique; repeat the same payload to recover a lost response. A business using
multiple invoice namespaces must prefix its reference with its organisation ID.

The generated QR contains `https://<wallet-origin>/pay/<random-request-uuid>`.
The page retrieves authoritative terms from the server, retains the invoice
through email/passkey sign-in, and uses the ordinary exact-payment review and
fresh passkey authorization. This is a Cherry Pay checkout link, not a generic
SEP-7 wallet URI. External wallets scanning only a C-address do not convey an
invoice reference. The merchant name is supplied by the wallet owner, not a
verified legal identity. Links disclose the merchant name, reference, address,
amount, aggregate paid amount and expiry; do not put customer PII in references.

The immutable attempt intent adds `paymentRequestId`. Its digest includes that
ID; existing non-invoice digests are unchanged. PostgreSQL validates the request,
recipient, network, native asset, remaining amount and expiry under a request
row lock in the attempt creation transaction. The global fee-relayer reservation
and existing idempotency/reset fences remain in force. Before authorization the
remaining amount and expiry are rechecked. An unknown signed outcome cannot be
reset, replaced or used as proof of payment. A confirmed attempt awaiting
allocation also blocks another payment. Requests can expire while an authorized
transaction is unresolved: later verified receipts are still allocated and
flagged as late. Invoice association is off-chain metadata, not an on-chain memo
or new Soroban payment-router contract.

## Settlement and audit

The receipt worker accepts only confirmed, independently verified attempts and
their committed native-SAC transfer events. It matches the persisted request,
hash, event ID, source, recipient and exact amount. The receipt key is
`TESTNET:<transactionHash>:<operationIndex>:<eventIndex>`, not an amount or time.
Each receipt is allocated in full to one invoice; a primary key prevents double
credit across retries, workers and invoices. Allocation and its outbox event
commit atomically. A worker restart recovers any confirmed but unallocated
attempt. Polling does not create transfers.

Verified address-only deposits are **unmatched**. The merchant can explicitly
assign a receipt from their own wallet to an invoice with an evidence note and
confirmation. Another merchant's receipts, already allocated receipts and
invoice-checkout receipts cannot be reassigned. Funding grants also appear as
unmatched receipts; operators must not assign them as customer payments. The
audit retains the authenticated actor, method, note, time and transfer reference.
There is no deletion, reversal, refund, or receipt splitting in this version.

Statuses are `unpaid`, `partially_paid`, `paid` and `overpaid`, calculated using
integer strings. Expiry and pending payment are separate fields. Partial manual
payments reduce the next checkout amount; excess payments are recorded in full.
If an external payment arrives after authorization, an overpayment is possible
and is shown explicitly. No automatic refunds or amount-based guesses occur.

## API

See [OpenAPI](payments.openapi.json) for schemas.

- `POST /api/v1/wallets/:walletId/invoices`: save/recover invoice request.
- `GET /api/v1/wallets/:walletId/invoices[?cursor=...]`: owned requests.
- `GET /api/v1/wallets/:walletId/invoices/:requestId`: terms and audit receipts.
- `GET /api/v1/payment-requests/:requestId`: public checkout terms only.
- `POST /api/v1/wallets/:walletId/attempts`: normal payment intent with optional
  `paymentRequestId`, plus the existing `Idempotency-Key`. Retrying a changed
  reference/recipient/amount fails; reusing a key recovers the same attempt.
- `GET /api/v1/wallets/:walletId/unmatched-receipts[?cursor=...]`: verified receipts.
- `POST /api/v1/wallets/:walletId/invoices/:requestId/allocate` with
  `{ "eventId": "TESTNET:...:0:0", "note": "Customer confirmed invoice reference" }`.

All merchant routes require the existing wallet owner bearer session; writes
also require the configured trusted Origin. No invoice caller can nominate an
arbitrary destination, asset, webhook URL, or settled transaction hash. Sessions
and signing authority remain separate. The external accounting application must
use an authorized merchant session for these APIs; machine-to-machine API keys
and an accounting-side receiver are not added to this wallet repository.

## Accounting webhook integration

The durable outbox is always populated on allocation. Delivery is disabled until
all three operator settings are configured in the API secret/environment store:

- `WALLET_INVOICE_WEBHOOK_URL`: fixed HTTPS receiver, no credentials/query/fragment.
- `WALLET_INVOICE_WEBHOOK_SECRET`: random shared secret of at least 32 characters.
- `WALLET_INVOICE_WEBHOOK_WALLET_IDS`: comma-separated explicit merchant wallet IDs.

Only allowlisted merchants' events go to that receiver. Do not combine unrelated
merchants into an accounting integration without an explicit wallet-to-company
mapping at the receiver. No webhook credentials belong in the frontend or QR.
Configure the same settings on API and worker (the worker runs in the API).

POST body `type=invoice.payment_recorded` includes a stable `id`, per-invoice
`version`, `walletId`, `invoiceReference`, `paymentRequestId`, network, asset
contract, destination, transfer ID, hash, ledger, amount received, invoice total,
aggregate paid, status, method and late flag. No payer email or audit note is sent.

Headers: `X-CherryPay-Event-Id`, `X-CherryPay-Timestamp` (Unix seconds), and
`X-CherryPay-Signature: v1=<hex HMAC-SHA256(secret, timestamp + "." + rawBody)>`.
The receiver must verify the signature with a constant-time comparison, reject
stale timestamps (for example, beyond five minutes), validate the Testnet/native
asset and its merchant mapping, and deduplicate by event ID/transfer ID in the
same transaction as its invoice ledger update. Return 2xx only after that commit.
Use version ordering if applying aggregate snapshots; older events must not move
an invoice backwards. Accounting entries should be based on each unique receipt.

Delivery is at least once: a response can be lost after receiver commit. The
outbox leases work with multiple workers, retries with capped exponential delay,
uses a five-second timeout and refuses redirects. A webhook outage never changes
the verified wallet settlement. Retain the same receiver identity when changing
configuration; delivered events are not automatically replayed to a new system.

## Verification and rollout

Migration `015_invoice_requests.sql` is additive; existing attempts retain their
IDs/digests and gain a nullable generated request FK. Tests exercise same-value
invoices, cross-owner isolation, concurrent creation/allocation, unknown outcome
fences, partial/overpayments, late receipts and webhook retry/leases. Chain and
WebAuthn inputs in these tests are mocks: this is not new live Testnet acceptance.
Run API typecheck/tests with PostgreSQL integration enabled and web build/lint/
tests, then export the OpenAPI document. Merge through review into develop.
Roll back application images if necessary; preserve invoice, allocation, outbox
and payment tables. Never delete receipt evidence or clear unknown attempts.
