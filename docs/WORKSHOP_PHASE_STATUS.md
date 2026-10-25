# Workshop implementation through step 5

The supplied workshop notes define an ordered sequence, not named phases:
B3 persistence, B4 SAC/relayer, B5 verification, B6 recovery, A4–A6 integration,
then A7/B7 acceptance. PostgreSQL supersedes the notes' original MySQL choice.

| Step | Delivered code | Remaining acceptance |
| --- | --- | --- |
| 1 — B3 | PostgreSQL identity/payment records, migrations, session-bound approval tickets, API schemas | Operational database backup/restore and retention |
| 2 — B4 | Native XLM SAC preparation, exact authorization binding, fee-only relayer, begin/finish WebAuthn approval | Reviewed contract-specific codec and deployment; actual passkey authorization on Testnet |
| 3 — B5 | Independent committed-event checks, history, balances, canonical event identity, receive code/TTL verification | Live C→G evidence against the selected account/verifier |
| 4 — B6 | Persistent idempotency/leases, same-bytes retry, unknown-outcome reconciliation and cursor | Live RPC timeout/restart exercise |
| 5 — A4–A6 | Authenticated HTTP adapter, explicit receive metadata, fee-limit review, passkey approval, persisted status, indexed history/receipts | Supply the verified B1/B2 adapter and run the browser/Testnet acceptance flow |
| 6 — A7/B7 | Automated negative tests and accessible recovery UI | Independent two-device recovery drill and screen-reader/narrow-screen browser acceptance |

## Contract selection finding

The previously recorded account hash
`1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a`
is blocked. The upstream Smart Account Kit's
[src/kit/auth-digest-scheme.ts](https://github.com/stellar/smart-account-kit/blob/main/src/kit/auth-digest-scheme.ts)
identifies it as predating the GHSA-jpg9-m7w4-c7wc fix. This is evidence from upstream
source, not a claim that this project has audited a replacement contract.
The pinned manifest remains historical; its deployment/spending flags stay false.

The current upstream package targets Stellar SDK 16.3.x and supports newer credential
and digest schemes; this application's tested payment engine is on SDK 14.6.1.
Do not transplant an encoding recipe or upgrade the SDK untested to bypass this gate.
Choose and review a patched account and verifier together, pin their reproducible
artifacts, then test exact authorization encoding and rule selection against those
contracts. Successful transaction inclusion alone is not deployment provenance.

## Begin/finish approval integration

`buildApp({ payments, passkeyCodec, receiveRoute })` composes trusted adapters.
`passkeyCodec.describe` must read CURRENT deployed code and rule policy, return the
contract-derived 32-byte challenge, exact authorized credential IDs, and the same
policy fingerprint as the attempt. It must bind rule IDs and every field covered by
the selected contract's digest scheme. `encode` turns the verified assertion into
that contract's signature payload, preserving unsigned invocation, nonce and expiry.
Do not implement these methods using database credential count or arbitrary HTTP
values. No permissive default codec is supplied.

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

The browser prefers advertised `approvalMode: webauthn`: it verifies the options
response against the reviewed attempt, calls the authenticator, then posts the
assertion. On timeout it keeps the attempt key and checks status; it never posts a
replacement. Fee labels explicitly say maximum, not actual charged fee.

## Live acceptance evidence still required

1. Reviewed/pinned patched account and verifier, source commits, WASM hashes and
   confirmed deployment transactions tied to the created contract addresses.
2. Current on-chain signer/rule reader and contract-specific assertion codec test
   vectors for the selected build, including changed nonce/expiry/rules/destination.
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
