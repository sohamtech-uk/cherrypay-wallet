# Automatic primary-passkey Testnet payments

A verified automatic C-wallet can receive native Testnet XLM and send with its original primary passkey. The one-time Friendbot allocation remains **10,000 XLM**. Sending checks actual on-chain balance; the funding status itself is not spending authority. Users review each recipient, exact amount and fee cap and approve a fresh WebAuthn challenge.

## Deployment

Enable `WALLET_DEPLOYMENTS_ENABLED=true` and `WALLET_PRIMARY_PAYMENTS_ENABLED=true`. Keep `WALLET_PAYMENTS_ENABLED=false` and omit `WALLET_PAYMENT_MANIFEST`; mixing modes fails startup. Configure the existing deployment sponsor and a **different**, funded Testnet fee sponsor using `STELLAR_RELAYER_PUBLIC_KEY` and secret-store `STELLAR_RELAYER_SECRET`. The G-account is infrastructure paying transaction fees, not the user's wallet. Users own C-contract wallets. Never expose either sponsor secret in logs or frontend settings.

Migrations run before startup, including additive migration 013 for the persisted payment monitor start. Local operators can use `compose.primary-payments.yaml` with `compose.yaml` and injected sponsor credentials. Keep Aurora Testnet funding disabled.

Activation requires a durable CONFIRMED deployment, verified primary binding, canonical descriptor/address, the same owned P-256 credential, pinned account/verifier bytecode and current single permanent Default rule with no policies. The current rule fingerprint is inserted atomically and never overwritten by discovery. The deployment worker and authenticated owner discovery activate eligible wallets, including existing funded users. The UI discovers and opens the owned wallet after confirmation without asking for another sign-in ceremony.

## Transfer boundaries

The existing exact-transfer authorization, session/owner binding, RP/origin/user verification, counter checks, nonce/ledger expiry, on-chain auth-digest comparison and enforcing simulation remain required. Only the original primary credential can spend. The fee relayer cannot authorize a C-wallet debit. Signed transaction bytes are checkpointed before submission; unknown outcomes keep the same attempt and source reservation until reconciled. Recipients can be funded G-accounts or another verified Cherry Pay C-wallet. Receive instructions explicitly require native XLM SAC transfers for C-addresses; classic payment operations do not target contracts.

Balance requests read the native SAC directly after owner authentication. Confirmed transfers are decoded from committed RPC transaction events and shown in both wallets' history. The monitor starts at the earliest verified deployment and persists that boundary and its cursor across restarts. It never resets to conceal missing history; an RPC retention gap requires operator reconciliation. Indexer read models remain optional and cannot verify receipts or authorize spending.

## Recovery and rollback

`spendingEnabled=true` is separate from `recoveryReady=false`. Another profile passkey is a login credential, not automatically an on-chain backup signer. Keep the original primary passkey available. Independent backup recovery requires a separately authorized on-chain signer and physical-device recovery evidence; this mode does not claim that evidence. The existing two-rule manifest mode is unchanged and cannot silently downgrade to one rule.

Pause new payment access with `WALLET_PRIMARY_PAYMENTS_ENABLED=false`. Preserve PostgreSQL attempts, signed bytes, sponsor secrets and monitoring cursors. Reconcile pending or unknown submissions before changing sponsor identity or restoring payment access. Do not delete records or regenerate an existing sponsor on restart.

## Validation scope

Unit tests exercise exact primary authorization, wrong-credential rejection, explicit mode selection, no two-rule downgrade, recipient checks, owner-only activation, fresh balances and automatic UI connection. PostgreSQL integration tests cover concurrent activation, credential changes, immutable policy bindings and durable monitor boundaries. These synthetic tests do not substitute for a live RPC-verified transfer or physical-device recovery acceptance.
