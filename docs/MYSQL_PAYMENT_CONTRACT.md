# MySQL payment repository handoff — Sunil

Sunil owns MySQL implementation. This PR adds **no competing database driver, SQL migration or persistence implementation**. The payment engine consumes `PaymentRepository` in `apps/api/src/payments/repository.ts`; every operation is asynchronous and must resolve only after its database transaction commits. The in-memory repository under `test-support/` is a test double and is never wired into the server.

The observed `feat/wallet-p0-security-foundation` branch has `mysql2`, the shared `db` pool, `sessionAccount(token)` and these InnoDB tables: wallet_accounts, wallet_credentials, wallet_challenges and wallet_sessions. Keep those owned by Sunil. Map `Wallet.owner` to the verified wallet_accounts.id; a registered passkey account is not itself a deployed Stellar wallet.

## Records to add in Sunil's migration

Names below are proposals to align, not executed DDL.

| Record | Suggested table | Required fields and constraints |
| --- | --- | --- |
| Deployed wallet | wallet_onchain_accounts | id, owner FK to wallet_accounts, TESTNET network, unique C-address, current verified policy fingerprint, allowed destination routes, createdAt |
| Payment attempt | wallet_payment_attempts | immutable UUID, wallet FK, binary/case-sensitive idempotency key, canonical request digest, intent amounts as decimal strings/DECIMAL(19,0), source, policy, status, preview XDR/auth/expiry, signed XDR/hash, verified event ID, lease token/expiry, timestamps; UNIQUE(wallet_id,idempotency_key) |
| Relayer reservation | wallet_relayer_locks | primary key identifying this dedicated network/relayer, unresolved attempt ID; serialize reservation with SELECT FOR UPDATE |
| Verified event | wallet_transfer_events | canonical event ID primary key, transaction hash, ledger, operation index, event index, from/to, amount, closedAt; same identity with different payload must fail |
| Balance snapshot | wallet_balance_snapshots | wallet address/network key, exact amount, ledger, updatedAt; reject older-ledger overwrite |
| Monitor checkpoint | wallet_monitor_cursors | network + native SAC + relayer/indexer identity, opaque RPC cursor, optional backfill metadata; compare-and-swap update |

Never use JS Number or MySQL FLOAT/DOUBLE for stroops, sequence numbers or nonces. Preserve large DECIMAL/BIGINT values as strings in the driver. UUIDs, hashes, addresses and idempotency keys need case-sensitive binary comparison. Network/relayer names must scope locks and checkpoints if the same database hosts multiple environments. This engine is Testnet-only.

## Atomic method requirements

- `wallet(id, owner)`: constrain both columns in SQL; return 404 for a missing or another owner's record. Wallet provisioning is a trusted B1/B2 operation, not a public payment endpoint.
- `create(wallet,intent,key)`: in one transaction lock the dedicated relayer reservation, look up the wallet/key, return the old record if its digest agrees (409 otherwise), check no unresolved attempt, insert preparing attempt and reserve relayer. No unsigned preview or unknown outcome may be bypassed using a new key. Handle unique-key races by reading the committed winning record, never blindly retrying another key.
- `claim(id,statuses)`: SELECT FOR UPDATE, require expected status and expired/no lease, mint a random fencing token, set a 120-second lease and commit. Use a consistent database clock for expiry.
- `checkpoint(attempt,token)`: lock the attempt, require the currently stored token, call `validateAttemptUpdate`, persist the new state **without releasing the lease**, and commit. Used before external network effects. A rejected or ambiguous DB write must never be followed by broadcast.
- `finish(attempt,token,events)`: in one transaction check fencing/immutable fields/status, insert or compare identical event records, update attempt and release lease. Release the relayer reservation only for confirmed/failed/rejected. An event collision rolls back the complete operation. Do not swallow constraint failures.
- `ingest(events,expectedCursor,nextCursor)`: lock cursor row, compare current with expected, validate/dedupe every event, then update the cursor in the same transaction. Roll back the whole page on any mismatch. RPC retention gaps must not reset the cursor to latest.
- `setBalance`: validate exact nonnegative integer string and positive ledger; update only if the incoming ledger is not older. Return timestamps so stale snapshots are visible.
- `list`/`history`: owner scope is enforced before the query. Return at most 51 rows (50 plus lookahead) with stable keyset cursors: attempts by creation sequence/id; events by ledger/id. Validate and parameterize cursors. The opaque cursor attached to each result resumes strictly after that result.
- `allWallets`, `unresolved`, `get`, `cursor`: internal worker reads; no unauthenticated HTTP exposure. Reads must return independent objects so service mutations do not alter stored state before a commit.

MySQL does not support SQLite-style partial unique indexes. Use an InnoDB relayer reservation row (or an equivalent reviewed locking design), not a check-then-insert query without a lock. Keep database transactions short; **never hold a database lock during RPC calls**. Persist leases across workers and reject old tokens after lease reassignment. Do not implement application-level retry that duplicates a committed write after a connection error; recover using immutable IDs and idempotency keys.

## Session and runtime composition

Use the P0 branch's verified bearer session lookup to produce `{ subject: accountID }` for `registerPaymentRoutes.authenticate`. Do not treat an unverified bearer value, body accountID or localStorage watch address as identity. Session/cookie hardening remains Sunil's authentication responsibility. Exact mutation Origin is also required.

Pass the completed MySQL repository into `createPaymentRuntime({ repository, relayerSecret, policyReader, startLedger })`. Supply B1/B2's actual on-chain policy fingerprint/recovery reader. Register payment routes only after both adapters are validated. Default payment routes return 503, with no test-store fallback.

## MySQL integration acceptance (not yet executed)

Run against MySQL 8.4 with two separate pool connections/processes:

1. Simultaneous same-key requests produce exactly one attempt and identical IDs; changed intent conflicts.
2. Different keys and wallets cannot reserve the same relayer while an attempt is unresolved.
3. Process restart between signed-byte commit and broadcast recovers the same hash/XDR without reauthorization.
4. Simulate connection loss before/after commit; recovery is by ID/key, and no broadcast occurs until a durable state is established.
5. Old fencing tokens cannot checkpoint or finish after another worker claims the lease.
6. Event collision or cursor conflict rolls back every insert in the page; duplicate pages stay idempotent.
7. Terminal attempt/event/reservation updates commit together; unknown expiry never releases the slot.
8. Balance ledger never regresses; pagination has no skips/duplicates at equal timestamps/ledgers.
9. Owner isolation, numeric precision, database restart and backups/restore retain the complete attempt history.

The current unit tests validate payment-service sequencing against an asynchronous test double. They do **not** establish MySQL durability, locking, isolation or crash safety; those checks belong to Sunil's repository integration gate.
