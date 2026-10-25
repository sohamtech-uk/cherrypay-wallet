# Automatic Testnet C-address deployment and primary passkey binding

## What is implemented

With `WALLET_DEPLOYMENTS_ENABLED=true`, successful server-side WebAuthn registration queues an actual contract deployment. The background worker constructs, simulates, persists, submits and reconciles a Stellar `CreateContractV2` transaction. This is not the earlier reservation-only implementation.

The immutable deployment descriptor is derived from the authenticated owner's first verified stored ES256/P-256 credential, its exact public key and credential ID, pinned account/verifier identities and a deterministic owner-scoped salt. The fee source signs only the creation transaction. The contract constructor installs **one External WebAuthn primary signer in Default rule 0**, with no policies or expiry. It does not install the fee source as a wallet signer.

The application exposes a confirmed C-address only after checking the successful transaction's recomputed hash and exact creation operation, current account/verifier WASM bytes and TTL, and the deployed rule's exact owner credential. PostgreSQL records the confirmed ledger, transaction hash and signer rule. This evidence is an observation at confirmation; it is not a guarantee that future signer policy cannot change.

Two credentials in one default rule would require both signatures, not independent recovery. Therefore this implementation deliberately deploys the primary rule first. Additional off-chain credential enrollment does not silently rewrite that rule. **Backup on-chain enrollment and a lost-primary recovery exercise are separate work. Spending remains gated; a confirmed deployment is not a recovered/activated payment wallet.** No fake backup or recovery transaction hash is generated.

## Source pins

- Account WASM: `c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1`.
- WebAuthn verifier address and hash: the existing `TESTNET_V080` constants in `kit-v080-preflight.ts`. Do not substitute another verifier because its package version looks newer.
- Constructor reviewed at OpenZeppelin/stellar-contracts commit `ddc327eb92d63709436da3a8455f641c2d5476c5`, `examples/multisig-smart-account/account/src/contract.rs`.
- Upstream deployment/address encoding cross-checked against stellar/smart-account-kit commit `5e86845ab57ab2644958bc3a316d6fc33fee1275`, `src/kit/deploy-ops.ts`, `src/utils.ts` and its 2026-10-25 v0.8 deployment manifest.

The application keeps its existing pinned Stellar SDK and generated bindings. It does not install the older concatenated authorization-digest helper or accept caller-selected WASM/constructor arguments.

## Secure configuration

Deployment is **off by default**. Provision a dedicated, funded **Testnet** G-account exclusively for this deployment worker. Do not reuse the payment relayer account: both services need independent transaction sequences. Do not submit other transactions manually from this deployer while the worker is running.

| Variable | Purpose |
| --- | --- |
| `WALLET_DEPLOYMENTS_ENABLED=true` | Explicitly enable automatic contract creation |
| `STELLAR_DEPLOYER_SECRET` | Dedicated Testnet creation fee key; secret-manager value only |
| `STELLAR_DEPLOYER_PUBLIC_KEY` | Expected public G-address; must match the secret |
| `WALLET_DEPLOYMENT_MAX_FEE_STROOPS` | Maximum fee including resources; default 100000000 (10 XLM), hard ceiling 500000000 |
| `WALLET_DEPLOYMENT_PILOT_LIMIT` | Total distinct descriptors permitted per deployer; default 100, maximum 1000 |

Keep the secret outside Git, chat, shell history and logs. Use a local private environment file or Azure secret reference. Never print `docker compose config` without `--quiet` when it contains secrets.

A local-only key generation example, run from `apps/api` after `npm ci`, writes the secret to a mode-0600 file **outside the repository**, refuses to overwrite an existing file and prints only the public address:

```sh
node --input-type=module <<'JS'
import {Keypair} from '@stellar/stellar-sdk';
import {mkdirSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
const folder=join(homedir(),'.config','cherrypay-testnet');
mkdirSync(folder,{recursive:true,mode:0o700});
const key=Keypair.random();
writeFileSync(join(folder,'deployer.env'),
  `STELLAR_DEPLOYER_SECRET=${key.secret()}\nSTELLAR_DEPLOYER_PUBLIC_KEY=${key.publicKey()}\n`,
  {mode:0o600,flag:'wx'});
console.log(key.publicKey());
JS
```

Fund only that **public** address through Stellar Testnet Friendbot. Do not put the secret in a funding request. Confirm its network and funding before enabling the service. The legacy `/smart-account/relayer` endpoint describes the payment relayer, not this separate deployment key.

From repository root, using the existing local database `.env` file:

```sh
docker compose --env-file .env \
  --env-file "$HOME/.config/cherrypay-testnet/deployer.env" \
  -f compose.yaml -f compose.deployments.yaml config --quiet

docker compose --env-file .env \
  --env-file "$HOME/.config/cherrypay-testnet/deployer.env" \
  -f compose.yaml -f compose.deployments.yaml up --build -d
```

The API applies additive schema migration 010 on startup. This is schema initialization, **not a MySQL data migration**. No export/import, reset, deleted volume or altered historical migration is required. Azure operators should apply migrations through the existing database job and set the same configuration using secret references; these code changes do not modify a deployed Azure environment.

## Browser/API flow

1. Create a passkey profile with normal RP/origin and user-verification checks. A queue failure does not invalidate an otherwise verified registration.
2. Registration queues the primary deployment. Authenticated `POST /api/v1/smart-account/deployment` retries that same reservation; it accepts no owner, signer, salt, address, WASM or envelope override.
3. `GET /api/v1/smart-account/deployment` is read-only and owner-scoped. `SUBMITTED` means signed bytes were durably checkpointed; it is not a claim of network confirmation.
4. The UI polls pending/submitted jobs, even when the payment API is intentionally disabled. Predicted addresses are not shown as confirmed. Expired sessions and stale requests cannot restore another session's status.
5. `CONFIRMED` with `onChainSignerBound=true` displays the C-address and deployment transaction receipt. `recoveryReady` and `spendingEnabled` remain false. Complete independent backup enrollment/recovery before offering funding or payment controls.

## Retry and security invariants

- One immutable descriptor and deployment job per owner. Additional credentials do not create another address.
- One unresolved envelope per dedicated source; durable sponsor reservation plus unpredictable worker fencing tokens.
- Signed bytes, transaction hash and expiry COMMIT before any external submission.
- Lost commit acknowledgements and RPC timeouts resume saved bytes; no automatic new salt, new envelope or replacement signature.
- A successful outcome is confirmed only after code and primary rule inspection. Missing, replaced, foreign-owned or incompatible credentials block confirmation.
- Expired `NOT_FOUND` outcomes remain unresolved and keep the sponsor reserved. An operator must investigate using retained chain evidence; never clear reservations merely to unblock the queue.
- Schema/SQL transactions never span RPC calls. Claim and settlement use sponsor-first lock ordering.
- The pilot cap and fee cap are bounded safeguards, not a substitute for production abuse controls or security review.

## Acceptance and rollback

CI uses synthetic passkeys/RPC fixtures and real PostgreSQL for deterministic tests. It checks XDR encoding, exact signer/owner binding, startup guards, durable checkpoints, stale leases, idempotency, session/origin isolation, UI polling and failure states. It does **not** claim a live Testnet deployment or a physical-device recovery drill.

Live acceptance requires the operator to supply the dedicated funded Testnet key, register a real passkey, observe PENDING → SUBMITTED → CONFIRMED, verify the C-address and transaction independently, then reconnect and confirm no duplicate job/address. Exercise an RPC timeout/restart and inspect the same persisted transaction hash. Independently test actual passkey authorization against the deployed contract before enabling payments.

To stop new work, disable `WALLET_DEPLOYMENTS_ENABLED` and restart the API. This does not cancel a transaction already submitted. Preserve PostgreSQL records and the same dedicated key so uncertain transactions can be reconciled. Do not delete jobs, drop schema, rotate the deployment source or enable a replacement wallet while an outcome is unknown.
