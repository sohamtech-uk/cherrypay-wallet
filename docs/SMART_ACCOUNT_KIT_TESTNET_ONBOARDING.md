# Smart Account Kit Testnet onboarding — gated rollout

This project reuses the existing Stellar Smart Account Kit bindings and the pinned OpenZeppelin smart-account contract. **Do not deploy the legacy WASM hash in `kit-manifest.ts`**; `rejectLegacyAccountWasm` deliberately blocks it.

## Phase A — verify the upstream artifacts (operator action)

1. Review and pin the exact Smart Account Kit release, source commit, contract WASM, verifier WASM and deployment manifest.
2. Check that the approved account WASM equals `ACCOUNT_V080_HASH` in `pinned-adapter.ts`. Verify verifier bytecode and the intended Testnet passphrase independently.
3. Do not assume the package's default digest helper matches this account: `accountDigestPreimage` is pinned to the reviewed ABI.
4. Use separate Testnet-only deployment/fee-paying identities. Never expose secrets in HTTP requests or commit them.
5. Record deployment transaction hash and ledger evidence. No HTTP deployment endpoint should be added.

## Phase B — two independent WebAuthn credentials

1. Enroll the primary credential using the wallet registration API.
2. Enroll the backup credential on a **separate authenticator/device**.
3. Deploy the reviewed smart-account contract using the upstream kit's reviewed deployment flow, not a newly invented contract.
4. Configure exactly two permanent Default context rules, one signer per rule, no policies or delegation.
5. Prove that the backup can independently authorize a controlled recovery operation. Capture the **distinct** recovery transaction hash.
6. Verify the current signer IDs, contract code hashes and rules against a consistent ledger snapshot.

**Stop if any upstream ABI, signing scheme or verifier behavior differs from the pinned adapter.** Do not mark recovery ready based only on a second registered credential.

## Phase C — bind the existing Cherry Pay runtime

Create an operator-only manifest with the exact schema in `apps/api/src/smart-account/manifest.ts`. Store it outside the repository with restrictive permissions.

```sh
# In apps/api, with the application database and Testnet RPC configured:
WALLET_PAYMENT_MANIFEST=/secure/path/wallet-payment-manifest.json npm run wallet:provision -- --check
WALLET_PAYMENT_MANIFEST=/secure/path/wallet-payment-manifest.json npm run wallet:provision -- --apply
```

The provisioning CLI **does not deploy contracts**. It verifies the approved on-chain policy and atomically binds existing wallets. Start the API with `WALLET_PAYMENTS_ENABLED=true` only after all security evidence is independently reviewed; keep it `false` otherwise.

## Phase D — Testnet acceptance

- Passkey-signed native XLM payment from approved C-address to G-address
- Relayer G-account pays fees but cannot authorize wallet spending
- Signature and policy fingerprint survive prepare/authorize without unexpected changes
- RPC simulation enforces the deployed contract's `__check_auth`
- Receipt includes the exact matching native SAC transfer event
- Replay, stale approval, wrong owner, wrong destination, signer rotation and expired auth fail closed
- RPC timeout, restart and concurrent reconciliation do not create duplicate payments
- Backup-device recovery succeeds after primary credential loss

Do not enable mainnet, supplier settlement or payroll based solely on unit tests.

## Implementation boundary

The current repo has **verification, provisioning, payment authorization and reconciliation**. It does **not** yet contain a reviewed on-chain contract deployment/signer-enrollment transaction builder. Implement that separately only after verifying the upstream Smart Account Kit deployment API and artifacts. Never infer or invent an ABI from the npm binding version.
