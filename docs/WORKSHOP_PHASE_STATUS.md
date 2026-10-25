# Workshop implementation through step 5

The supplied workshop notes define an ordered sequence, not named phases:
B3 persistence, B4 SAC/relayer, B5 verification, B6 recovery, A4–A6 integration,
then A7/B7 acceptance. PostgreSQL supersedes the notes' original MySQL choice.

| Step | Delivered code | Remaining acceptance |
| --- | --- | --- |
| 1 — B3 | PostgreSQL identity/payment records, migrations, session-bound approval tickets, API schemas | Operational database backup/restore and retention |
| 2 — B4 | Native XLM SAC preparation, exact authorization binding, fee-only relayer, begin/finish WebAuthn approval, source-pinned account codec | Reviewed deployment; actual passkey authorization on Testnet |
| 3 — B5 | Independent committed-event checks, history, balances, canonical event identity, receive code/TTL verification | Live C→G evidence against the selected account/verifier |
| 4 — B6 | Persistent idempotency/leases, same-bytes retry, unknown-outcome reconciliation and cursor | Live RPC timeout/restart exercise |
| 5 — A4–A6 | Passkey profile enrollment, owned-wallet overview, authenticated HTTP adapter, explicit receive metadata, fee-limit review, passkey approval, persisted status, indexed history/receipts, concrete trusted runtime composition | Supply accepted B1/B2 deployment configuration and run the browser/Testnet acceptance flow |
| 6 — A7/B7 | Automated negative tests and accessible recovery UI | Independent two-device recovery drill and screen-reader/narrow-screen browser acceptance |

## Contract selection finding

The previously recorded account hash
`1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a`
is blocked. The upstream Smart Account Kit's
[src/kit/auth-digest-scheme.ts](https://github.com/stellar/smart-account-kit/blob/main/src/kit/auth-digest-scheme.ts)
identifies it as predating the GHSA-jpg9-m7w4-c7wc fix. This is evidence from upstream
source, not a claim that this project has audited a replacement contract.
The pinned manifest remains historical; its deployment/spending flags stay false.

The API now pins Stellar SDK 16.3.0 and generated account bindings 0.4.0. The payment
engine supports address credentials V1 and V2, while rejecting source-account and
delegated credentials. The browser SDK is unchanged.

The new `PinnedAccountAdapter` targets the OpenZeppelin v0.8.0 structured
`AuthDigestPreimage`, reviewed at source commit
`ddc327eb92d63709436da3a8455f641c2d5476c5`, and account WASM
`c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1`.
The published npm `smart-account-kit@0.8.0` helper still used a concatenated digest
when checked; it is deliberately not a dependency. A version label is insufficient
to choose an authorization scheme. Before offering a challenge, the adapter calls
the pinned account's pure `auth_digest` helper and compares its result. Tests check
the Rust struct layout and actual P-256 signature encoding; they do not execute the
deployed WASM or establish artifact provenance.

Current code bytes, TTL and both signer rules must be read at the same ledger.
Exactly two permanent Default rules are accepted, each with one separately owned
P-256 key and no policies. A two-signer rule requiring both signatures is rejected
as a backup arrangement. Normal sends select the primary rule explicitly. This
release does not implement a recovery or signer-rotation ceremony; the trusted
manifest records operator-reviewed deployment and recovery evidence references.
Successful transaction inclusion alone is not deployment provenance.

## Begin/finish approval integration

`buildApp({ payments, passkeyCodec, receiveRoute })` composes trusted adapters.
`passkeyCodec.describe` must read CURRENT deployed code and rule policy, return the
contract-derived 32-byte challenge, exact authorized credential IDs, and the same
policy fingerprint as the attempt. It must bind rule IDs and every field covered by
the selected contract's digest scheme. `encode` turns the verified assertion into
that contract's signature payload, preserving unsigned invocation, nonce and expiry.
Do not implement these methods using database credential count or arbitrary HTTP
values. No permissive default codec is supplied.

`createPinnedPaymentRuntime({ accounts, relayerSecret, startLedger })` now returns
all three dependencies for `buildApp`. Call it only from a trusted server
composition root after initializing PostgreSQL and accepting deployment/recovery
evidence. Each manifest item uses the `ApprovedAccount` type; no sample deployment
addresses or keys are supplied. Existing `wallet_onchain_accounts` rows must match
the approved owner, wallet ID, address and freshly read policy fingerprint. The
initial outgoing destination policy must be exactly `['classic']` (C→G). A mismatch
fails startup without rewriting the stored policy or broadcasting a transaction.
The default server entry point remains disabled without explicit configuration.
It now loads a strict public manifest when `WALLET_PAYMENTS_ENABLED=true`, verifies
the dedicated relayer identity and saved bindings, then composes the runtime before
listening. An operator CLI checks/provisions already accepted deployed accounts
atomically without overwriting authority. There is no public provisioning API or
automatic deployment. See [TESTNET_STARTUP.md](TESTNET_STARTUP.md).

The API persists a one-use ticket bound to owner, session hash, wallet, attempt,
request digest, authorization XDR hash, policy, allowed credentials and expiry.
Consumption commits before verification, so an invalid assertion cannot reuse the
ticket. Real WebAuthn verification requires RP/origin, user verification, the stored
public key and counter, and the allowed on-chain credential. The existing relayer
then checks the signature using enforced contract simulation; only it submits.
Session deletion cascades outstanding tickets. Expired tickets are cleaned at issue.

`verifiedReceiveRoutes` checks the reviewed account and verifier WASM bytes from
ledger entries, their TTL, Testnet identity, and current recovery policy before
publishing funding instructions. Its approved deployment map must be populated only
after the deployment and independent recovery acceptance gate, not from client data.

Authenticated wallet discovery now removes the manual deployed-wallet-ID field.
A single owned wallet opens automatically; multiple wallets require selection.
The API scopes discovery by the verified session owner. Expired/disconnected
sessions cannot be restored by late frontend responses.

Initial and additional passkey enrollment are now available in the profile panel.
Registration options and verification require ES256/P-256. The public account ID is
saved before registration for uncertain-response recovery; tokens remain in memory.
Additional enrollment rotates the browser session and revokes the previous one.
The connected overview shows exact indexed balance, its ledger/age, and verified
activity/receipts with independent error recovery. Enrollment count never marks a
wallet as recovery-ready or triggers automatic deployment.

The browser prefers advertised `approvalMode: webauthn`, even if an external signer
was injected. The raw approval route is disabled in WebAuthn mode so it cannot skip
the API RP/origin/counter checks. The browser verifies the options
response against the reviewed attempt, calls the authenticator, then posts the
assertion. On timeout it keeps the attempt key and checks status; it never posts a
replacement. Fee labels explicitly say maximum, not actual charged fee.

## Live acceptance evidence still required

1. Reviewed/pinned patched account and verifier, source commits, WASM hashes and
   confirmed deployment transactions tied to the created contract addresses.
2. Execute the implemented signer/rule reader, digest-helper comparison and
   assertion codec against that deployed build, including changed
   nonce/expiry/rules/destination. Local layout/signature tests alone are insufficient.
3. Dedicated Testnet relayer configuration supplied through secret storage.
4. Primary and independent backup passkeys enrolled and authorized on-chain; actual
   recovery after losing access to the primary device.
5. Browser receive → prepare → approve → confirmed exact SAC event → receipt, then
   RPC timeout/restart, duplicate-session and signer-rotation negative cases.

No relayer secret or connected passkey devices were available in this execution
environment. No Testnet deployment, funding or live transfer is claimed. Software
fixtures prove application boundaries; they do not prove on-chain compatibility or
physical-device recovery. Phase 5 live acceptance therefore remains blocked by B1/B2.

## Rollout and rollback

Apply migration 003 before configuring approval routes. It adds only approval tickets
and does not change prior migrations. Roll back application code without dropping
existing identity/payment data; unused tickets expire. Keep deployment and spending
disabled until evidence above passes. CI must pass both API/PostgreSQL and frontend
checks before merging. All work remains Testnet-only.
