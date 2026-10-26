# Configure the existing Testnet payment flow

For automatic single-primary wallets, use the explicit [primary Testnet payment mode](PRIMARY_TESTNET_PAYMENTS.md). The two-rule manifest and independent recovery requirements below continue to apply to the reviewed recovery mode.

The default server keeps payments disabled. The normal server entry point can now
load an explicitly enabled, reviewed deployment manifest, verify the saved wallet
bindings and construct the payment/approval/receive adapters before listening.
No source edit is required to enable a completed B1/B2 deployment.

## Public manifest

Keep the operator-reviewed manifest outside the repository. Its top-level fields
are `version: 1`, `network: "TESTNET"`, `startLedger`, `relayerPublicKey`, and
`accounts`. Each account has exactly the fields in
[`ApprovedAccount`](../apps/api/src/smart-account/pinned-adapter.ts):

| Field | Source |
| --- | --- |
| `walletId` | Stable application wallet ID, 1–128 ASCII letters/digits/underscore/hyphen |
| `owner` | Existing enrolled account UUID; not a session token |
| `address`, `accountWasmHash` | Reviewed deployed smart account and the supported pinned v0.8.0 WASM hash |
| `verifierAddress`, `verifierWasmHash` | Reviewed deployed WebAuthn verifier and its WASM hash |
| `primaryRuleId`, `backupRuleId` | Distinct, permanent single-signer Default rules with no policies |
| `primaryCredentialId`, `backupCredentialId` | Canonical base64url IDs of separately owned, independent P-256 credentials |
| `deploymentTransactionHash`, `recoveryTransactionHash` | Distinct confirmed transaction references from accepted deployment and two-device recovery evidence |

The manifest accepts at most 100 accounts and rejects unknown fields, duplicate
wallet identities, legacy code and missing evidence references. Its evidence hashes
are operator attestations, not automated proof that a transaction deployed the
account or exercised physical-device recovery. Acceptance remains required before
provisioning. There is no runnable example containing fabricated deployment values.

Use a dedicated Testnet fee-paying relayer's G-address as `relayerPublicKey`.
`startLedger` is the earliest required indexing boundary, within the RPC provider's
available history. If the required boundary or persisted cursor has expired, backfill
and verify the missing range; do not reset the cursor to hide missing history.

## Provision and start

1. Run the default application to initialize PostgreSQL. Enroll the primary and
   backup credentials through the existing enrollment flow. Complete contract
   deployment and independent recovery acceptance, then prepare the public manifest.
2. Set `WALLET_PAYMENT_MANIFEST` to its absolute path. From `apps/api`, run
   `npm run wallet:provision -- --check` against that application database. The
   default is check-only: it verifies current on-chain code/TTL/rules and ownership
   while rolling back the database transaction. No relayer secret is needed.
3. Run `npm run wallet:provision -- --apply` to insert the reviewed wallet records.
   This applies migrations first and commits the entire batch atomically. Repeating
   the command is idempotent. A different owner/address/policy or outgoing route
   fails without updating existing records. Signer rotation requires a separate
   reviewed recovery procedure; this command cannot overwrite a policy.
4. Inject `STELLAR_RELAYER_SECRET` through server secret storage, set
   `WALLET_PAYMENTS_ENABLED=true`, and run `npm start`. The derived public key must
   equal the manifest's `relayerPublicKey`. Migrations and runtime verification run
   before the HTTP listener or payment worker starts. Invalid enable flags,
   incomplete configuration, unavailable RPC or changed wallet bindings fail startup.
   The bounded PostgreSQL connection retries and Compose TCP readiness check from
   PR #24 remain in place; shutdown cancels pending startup retries.
5. In the web app, enter the account ID and authenticate with the passkey. One owned
   wallet opens automatically; multiple wallets require selection. An account with
   no deployed wallet gets a setup message. Wallet IDs, owner IDs, credentials and
   signed payloads are never accepted as substitutes for an authenticated session.

Session tokens remain in memory. Expiry/disconnect invalidates in-flight connection
responses, so a late wallet response cannot reconnect a signed-out session. In
WebAuthn mode the raw `/approve` endpoint returns `EXTERNAL_APPROVAL_DISABLED`;
only the one-use, session-bound begin/verify flow can authorize a transfer. The
external-signer adapter remains available only in external mode.

## Docker Compose

Use `compose.yaml` for the default disabled setup. `compose.payments.yaml` adds a
read-only manifest mount and explicit runtime environment configuration. It does
not enable payments by itself; the enable flag still defaults to false.

```sh
docker compose -f compose.yaml -f compose.payments.yaml build api
docker compose -f compose.yaml -f compose.payments.yaml run --rm api npm run wallet:provision -- --check
docker compose -f compose.yaml -f compose.payments.yaml run --rm api npm run wallet:provision -- --apply
docker compose -f compose.yaml -f compose.payments.yaml up -d api web
```

Supply the public manifest path and database settings in the operator environment;
inject the relayer secret only when starting enabled payments. Set `WALLET_ORIGIN`
and `WEBAUTHN_RP_ID` for the actual browser origin (localhost is the development
default). The override refuses to create a missing host manifest path. Avoid printing
resolved Compose configuration when secrets are present; CI validates synthetic
configuration with `config --quiet`.

For rollback, set `WALLET_PAYMENTS_ENABLED=false` and restart. Keep PostgreSQL rows,
applied migrations, signed attempts and monitoring cursor. Shutdown drains the
payment worker before closing the database. Restarting with the same approved
configuration resumes durable attempts using their existing signed bytes.

## Acceptance still pending

These commands make the implementation configurable; they do not establish live
acceptance. Record the deployed code/source evidence, primary and backup device
recovery, receive → send → confirmed exact SAC event → receipt, and timeout/restart
results described in [WORKSHOP_PHASE_STATUS.md](WORKSHOP_PHASE_STATUS.md).
