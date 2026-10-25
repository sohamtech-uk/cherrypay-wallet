# C-to-C native-XLM rollout and backup-recovery acceptance

This document supersedes the earlier **classic-only outgoing route** restriction in the workshop notes. Everything is Stellar **Testnet only**. Passing CI is not a claim that an actual wallet was funded, a passkey was enrolled on-chain, or a two-device recovery drill was completed.

## Delivered software

- Approved wallets support `['classic','contract']` destinations. C recipients must be another explicitly provisioned wallet with a currently valid independent backup rule and a signer-policy fingerprint matching PostgreSQL.
- Recipient checks run during initial creation/preparation, before and after authorization, and before rebroadcast. A previously persisted idempotent attempt can still be recovered while policy RPC is unavailable.
- Reconciliation establishes transaction outcome **before** revalidating a receiver. A later signer change cannot erase a confirmed payment. An uncertain signed attempt stays reserved; it is not replaced, cancelled or re-signed because a recipient check fails.
- The same exact native-SAC transfer event is visible in sender and receiver history, with separately indexed exact integer-stroop balances. Synthetic lifecycle tests and real PostgreSQL tests cover both users and ownership isolation.
- Current contract checks are observations, not an atomic guarantee that a receiver cannot change policy between the last RPC read and ledger execution. The sender contract still enforces exact transfer authorization on-chain.

## Existing-wallet route upgrade

Run from `apps/api` with the normal **Testnet** database connection, `WALLET_ORIGIN`, `WEBAUTHN_RP_ID` and `WALLET_PAYMENT_MANIFEST` configured for the reviewed deployment. The public manifest must remain outside Git; do not paste relayer secrets or private keys into an agent.

```sh
# Plan only: reports proposed changes and rolls back SQL.
node --import tsx src/smart-account/provision-cli.ts --check --enable-contract-routes

# Explicit operator-approved application of the reviewed plan.
node --import tsx src/smart-account/provision-cli.ts --apply --enable-contract-routes
```

The upgrade changes only an existing exact `['classic']` route to `['classic','contract']`. It will not change wallet owner, address, network, signer policy, credentials or on-chain rules. It refuses unresolved payment attempts and commits a manifest batch atomically. Without `--enable-contract-routes`, old classic-only bindings fail closed. Chain reads finish before SQL row locks are acquired; startup and transfer operations independently recheck chain policy.

This is **not a MySQL data migration** and does not need an export/import or database reset. No existing application data should be deleted.

## Per-user backup evidence audit

```sh
node --import tsx src/smart-account/recovery-audit-cli.ts
```

The audit is now genuinely read-only: no migration startup, enrollment, signature generation, transaction submission, policy rewrite or readiness update occurs. For **each** manifest wallet it checks current approved account/verifier code and the user's two independent on-chain signer rules, then fetches `recoveryTransactionHash` from Testnet RPC and requires:

1. A successful transaction with a matching recomputed transaction hash and one native-XLM SAC transfer from that user's contract.
2. Exactly one authorization selecting the user's **backup rule only**, not the primary rule or a primary-plus-backup combination.
3. The expected backup verifier/key/credential, owned by that user and using a different P-256 public key from their primary credential.
4. A valid P-256 signature over the exact network-, account-, rule-, nonce-, expiry- and invocation-bound WebAuthn challenge, with the configured RP ID/origin and user verification.
5. An independently matched committed transfer event with the exact sender, destination and amount.

Success reports `onChainBackupConfigured: true` and `backupSpendVerified: true`. It deliberately reports `physicalDeviceIndependenceVerified: false`: different keys and a valid signature do not establish that devices are physically independent or that the primary was inaccessible.

A missing/expired RPC transaction, primary-signed transaction, wrong owner, changed key, invalid signature, RP/origin mismatch, wrong network or unmatched event fails the audit. Historical evidence outside RPC retention needs an independently reviewed archival verification path; this command does not silently waive the requirement.

## What is NOT implemented or executed by this change

- No new in-app on-chain backup-enrollment/signing ceremony is provided. Existing profile enrollment creates WebAuthn credentials off-chain; it does not add a contract signer.
- The current normal payment approval still selects the primary rule. The owner-operated backup-signing flow is a separate remaining implementation/integration item, not something this audit can perform.
- No user's passkey has been fabricated, moved to another owner, automatically enrolled on-chain or signed by the relayer.
- No live two-user C-to-C transfer or lost-primary-device exercise has been performed by CI. The cryptographic tests use generated test keys and synthetic RPC responses, clearly separate from deployment evidence.

## Live release checklist

For each of two users, independently enroll a backup on-chain using the reviewed contract/owner-authorization workflow. Keep the primary authenticator unavailable during that user's backup-only Testnet signing exercise. Record the backup-only transfer hash and run the evidence audit; separately document the physical-device exercise.

Then provision/upgrade the reviewed wallet records and run: user A receives XLM, A reviews and signs a C-to-C transfer to B, exact committed native-SAC event is verified, both balances refresh, both histories show the same transaction, and receipt gating behaves correctly. Exercise recipient rotation, RPC outage, unknown-outcome recovery, repeat idempotency key and signer rejection. Keep the runtime disabled until the complete deployment, enrollment and live acceptance evidence is reviewed.
