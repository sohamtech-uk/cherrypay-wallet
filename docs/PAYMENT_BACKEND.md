# B3–B7 Testnet payment backend

## Scope and status

Branched directly from `develop` at `5ad74658252d7aeb73fb04374d815401c05f85e5`, preserving the merged B1/B2 foundation, payment screens and Docker setup. This implements payment record contracts, authenticated API boundaries, native XLM SAC transaction construction, fee-only relaying, transaction verification, indexing and safe recovery. It does not claim that B1 smart-account deployment or B2 independent recovery have passed their gates.

The default server registers payment routes but returns **503 PAYMENT_INTEGRATION_NOT_CONFIGURED**. There is deliberately no fake session, account-ID-based authorization, default signer policy or automatic contract selection. Sunil's existing passkey registration/authentication prototype is not a spending authorization adapter.

## Files and integration

- `src/payments/model.ts`: frontend-facing types, exact stroop validation, Testnet/native SAC identity and public response mapping.
- `repository.ts`: asynchronous MySQL repository contract and reusable immutable-record/status/event validation. Sunil implements the persistence layer; this PR does not create a competing database.
- `stellar.ts`: native SAC `transfer(from,to,amount)` construction, recording/enforced simulation, signature-only authorization binding, fee sponsor signing, hash/event verification and balance/event reads.
- `service.ts`: persistence before network writes, policy checks, retries and monitoring.
- `routes.ts`: Fastify request schemas and owner-scoped endpoints. `docs/payments.openapi.json` is the public API contract.
- `runtime.ts`: Testnet RPC/relayer composition with an injected MySQL repository. `worker.ts`: non-overlapping background monitor.

Use Node **22+** (tested on Node 24). **MySQL is the backend database, implemented by Sunil.** See [MYSQL_PAYMENT_CONTRACT.md](MYSQL_PAYMENT_CONTRACT.md) for the interface, proposed record layout and required InnoDB transaction/locking behavior. No SQLite dependency, SQLite schema, alternative production store or automatic migration is included. The in-memory test double is never used by the running server.

The integration composition root must:

1. Create a dedicated **Testnet fee sponsor** via secret management. Do not reuse a customer account or share this account with another application. Never log the secret or signed authorization payloads.
2. Implement `PolicyReader.current(address)` using the selected B1/B2 contract's actual on-chain signer/recovery state. Return a canonical fingerprint that changes for any signer, threshold, recovery, upgrade or policy change. Return recoveryReady only after the independent recovery gate is satisfied.
3. Call `createPaymentRuntime({ repository, relayerSecret, policyReader, startLedger })`. The RPC URL and network passphrase are Testnet-only. Set startLedger to a recorded wallet deployment/backfill ledger, not an arbitrary current ledger that would skip history.
4. Provision wallet records through Sunil’s MySQL adapter from a trusted B1/B2 deployment flow after verifying ownership and independent recovery. This is intentionally not a public HTTP endpoint. Enable only Testnet destination routes actually validated in B1.
5. Call `registerPaymentRoutes(app, { service, origin, authenticate })`. `authenticate` must verify a real server-side session and return the owner subject; never trust accountID or a caller-provided owner header. Mutations require exact Origin. Configure Fastify with `ajv.customOptions = { removeAdditional: false, coerceTypes: false }`, as the default server does.
6. Start `startPaymentWorker(service, onError)` and stop it on shutdown, then close the MySQL pool after in-flight work completes. Monitoring errors expose only a generic operational code; alert on persistent failure, unknown attempts or cursor/backfill gaps.

Do not connect the development-only passkey endpoints to wallet provisioning or payment authentication. Sunil’s P0 branch migrates accounts, credentials, challenges and bearer sessions to MySQL. This PR leaves those files and migrations to him and supplies the payment repository contract for the same backend.

## Frontend adapter handoff

The current A4–A7 UI has a frontend-local `prepare → createAttempt → approve` interface. This backend exposes persistent `POST attempts → POST approve`; a frontend adapter must map that workflow, persist its idempotency key before POST attempts, and recover the same attempt on retry. Do not blindly wire the current local interface to HTTP without this mapping. Present `feeStroops` as a sponsored **maximum**, map preparing/authorizing/ready statuses explicitly, merge verified incoming history with outgoing attempts, and obtain contract-specific signed auth from B1/B2. The UI stays disabled until that integration is provided; this PR does not silently enable spending through the watch-only dashboard.

## Authorization and fee contract

The client submits Testnet destination, **integer stroops as strings**, and maxFeeStroops; the source is resolved from the authenticated wallet. Only native XLM is supported. No arbitrary contract, asset, RPC URL, source, transaction envelope or operation can be supplied via the payment API. G and C destinations must be checksum-valid and explicitly enabled; muxed/memo-required/federation routes and self-transfers are unsupported.

`POST attempts` records the intent first, then checks balance and simulates the native SAC transfer in **record** mode. The resulting challenge binds the native SAC, source, destination, exact i128 amount, nonce and short expiration. There is exactly one address-credential authorization, from the wallet C-address, with no nested invocation. Source-account authorization is rejected.

The approval response contains the unsigned authorization entry. The B1/B2 signer must sign the **Stellar Testnet Soroban authorization payload** using the selected smart-account contract's signature encoding. A WebAuthn login assertion is not sufficient. `POST approve` accepts only that entry with its signature populated. Everything else must match byte-for-byte. It invokes **enforce** simulation to execute the deployed contract's authorization checks before the fee sponsor signs. The actual on-chain contract performs the same check at execution, including rotation/replay rules.

The sponsor pays fees; the customer amount is unchanged. `feeStroops` in the preview is the **authorized fee ceiling**, not a promise of exact network fees. The server caps sponsorship at 1 XLM per transaction, and enforced simulation/assembly must remain under the user's lower cap. If authorization changes resource costs above the cap, the unsent attempt is rejected and requires a new review. No automatic top-up, archive restoration, increased fee cap or replacement authorization is performed.

## Persistence, retries and outcomes

An idempotency key is unique within a wallet. Reuse with another intent returns 409; reuse with the same intent returns the original immutable attempt, including after restart. Identity/digest/source and any persisted signed envelope/hash cannot be changed.

For this MVP, the repository contract requires a transactional MySQL relayer reservation allowing **one unresolved attempt across the dedicated relayer**, including unsigned previews. This deliberately serializes sequence use across wallets and processes. Cancel or expire unused previews to release the slot. Scale via a reviewed relayer queue/pool later; never share the relayer outside this database.

State progression:

- preparing → awaiting_approval → authorizing → ready → unknown → pending/confirmed/failed
- Preparation outages remain preparing and retry safely; no signing or broadcast has occurred.
- Invalid authorization, policy change or unsigned expiry leads to rejected. Cancellation is permitted only before signed bytes exist and with no live worker lease.
- Persist signed bytes and their local Testnet hash **before any broadcast**. Persist unknown before each network attempt.
- Worker always queries the stored hash before broadcasting. A timeout, sendTransaction ERROR/TRY_AGAIN_LATER, RPC outage or NOT_FOUND is not proof of failure.
- Before expiry, retry only identical persisted bytes. Never rebuild, bump sequence, change amount/recipient, replace nonce or reauthorize an uncertain attempt.
- After expiry, NOT_FOUND remains unknown and blocks replacements. Operator investigation/backfill must establish the outcome; there is no unsafe force-unlock HTTP endpoint.
- Only a matching getTransaction envelope/hash plus definitive failed result releases a failed attempt. Confirmation additionally requires exactly one matching committed native SAC transfer event.
- 120-second leases with fencing tokens coordinate workers. RPC timeout is 20 seconds. A stale worker cannot persist/broadcast a replacement after another worker acquires its lease.

`GET` and `/check` return stored status; they do not trigger spending. The worker progresses signed attempts. A lost approval response is recovered via attempt ID or `attempt-by-key`; the client must not create a new payment.

## Confirmation and indexing

getEvents is discovery only. Each discovered transaction is independently read via getTransaction. Verify its hash from the actual envelope under the Testnet passphrase and its committed result. Decode events only from the native XLM SAC, requiring transfer topics and integer amount (SEP-41 scalar or map format). Diagnostic/simulation events never establish payment success.

Canonical identity is `TESTNET:<transaction hash>:<operation index>:<committed event index>`. Event payload collisions are errors, not overwrites. Confirmation and its event commit atomically; event pages and the monitoring cursor also commit atomically with compare-and-swap. Duplicate pages are safe. An RPC retention error or unverified event transaction does not advance the cursor. Backfill from an archival source is required for an expired cursor; never silently reset it to latest.

History includes sent and received verified events. Attempts are separately listed, including pending/failed records. Both have owner-scoped keyset pagination. Receipt URLs are constructed only from verified Testnet transaction hashes. Balance snapshots are read from native SAC balance simulation at a known ledger, stored with ledger/time, and cannot regress to an older ledger. A missing snapshot is null, not zero. The API exposes snapshot age so clients can label stale values.

## Verification and remaining gates

Run `npm ci`, `npm run typecheck`, `npm test` in `apps/api`. Tests exercise the asynchronous repository contract using an in-memory test double, service reconstruction/recovery sequencing, leases, exact XDR construction/binding, SDK signature verification, mocked RPC behavior, event identity, schemas and owner isolation. MySQL durability, cross-process locking and real database restart tests remain Sunil’s integration responsibility. Mocked contract simulation is not evidence that a particular deployed smart account accepts passkeys.

Before enabling spending: validate B1/B2 deployment/recovery, provide the MySQL repository, on-chain policy reader and secure session adapter, and demonstrate real Testnet create → authorize → send → verify → restart/recover. Test RPC retention gaps, contract TTL restoration policy, sponsor funding, rate limits, deployment secret/storage controls and monitoring in that environment. No funds were moved or contracts deployed by this PR.

Dependency repairs: the original `@simplewebauthn/server@11.0.1` pin is not published; use 11.0.0 with its separately exported types package. Stellar SDK is pinned to 14.6.1 for explicit simulation authMode and current committed-event support. A lockfile is included. WebAuthn runtime logic is unchanged.

Rollback: disable composition/payment routes/worker and revert this PR. Preserve the MySQL payment records and reconcile all pending/unknown signed transactions before any replacement rollout. Never delete the database to clear a pending attempt.

## Primary references

- https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/simulateTransaction
- https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getTransaction
- https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/sendTransaction
- https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md
