# Standalone Cherry Wallet and optional Cherry Pay integration

Cherry Wallet is an independent Stellar Testnet wallet product. Wallet creation, passkey enrollment, account recovery, balance viewing and native XLM transfers must work without Cherry Pay, Cherry Money, supplier invoices, tenant identifiers or accounting services.

## Boundaries

- **Cherry Wallet owns:** user identity, WebAuthn credentials, on-chain C-address, signer and recovery policy, XLM payments, relayer authorization, transaction state and chain evidence.
- **Cherry Pay owns (future):** payment orchestration, merchant/supplier intents, organizational approvals and its own ledger reconciliation.
- No Cherry Pay credentials, tenant IDs, accounting records or Cherry Money APIs are required to initialize or use a wallet.
- A future connector must not import Cherry Pay's domain models into the wallet core.

## Configuration contract (future, disabled by default)

```dotenv
CHERRY_PAY_INTEGRATION_ENABLED=false
# Only when enabled and independently reviewed:
# CHERRY_PAY_ISSUER=https://example.invalid
# CHERRY_PAY_AUDIENCE=cherry-wallet
# CHERRY_PAY_JWKS_URL=https://example.invalid/.well-known/jwks.json
```

These settings document the future interface; they are **not implemented or accepted by the current runtime**. Do not set the flag to true until the connector exists and its security tests pass.

## Proposed future verification protocol

1. Register a Cherry Pay integration client explicitly with a scoped client identity, environment and key rotation policy.
2. Verify signed JWT requests against pinned issuer, audience, algorithm, key identifier, expiry, not-before, replay nonce and short maximum lifetime. Reject unknown keys, untrusted JWKS origins and unsigned requests.
3. Bind each request to a wallet owner-approved consent with explicit scope, destination/amount restrictions and expiry. Cherry Pay must never be able to sign with a user's passkey or silently initiate wallet spending.
4. Wallet returns a stable payment-intent ID and independently verified transaction evidence. Cherry Pay reconciles that evidence to its own accounting ledger.
5. Treat network failures and unknown outcomes as pending; enforce idempotency and verify chain events before confirmation.
6. Support immediate revocation, audit logging, per-client rate limits and complete separation between Testnet and Mainnet.

## Standalone P0 delivery order

1. Reuse upstream Smart Account Kit v0.8.0 account and verifier contracts and bindings.
2. Deploy Testnet C-address and enroll primary passkey.
3. Enroll a distinct backup authenticator and prove independent recovery on-chain.
4. Verify on-chain contract code and signer rules against pinned artifacts.
5. Execute sponsored native XLM transfer with independent chain-event reconciliation.
6. Expose accurate wallet status and recovery readiness to the standalone UI.

**Release gate:** keep spending disabled until the deployed contract, primary/backup signer rules and recovery transaction are independently verified. Do not confuse the existing operator manifest/provisioning flow with actual contract deployment.
