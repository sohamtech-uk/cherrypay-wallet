# Testnet payment runtime

Payment endpoints return 503 unless the API is started with a payment runtime. The runtime
is composed in `apps/api/src/server.ts` from environment variables, never from HTTP input.
It applies only to the patched account WASM and WebAuthn verifier pinned in
`apps/api/src/smart-account/kit-manifest.ts`. **Testnet only.**

## 1. Register the deployed smart account

After the browser flow has registered the user's passkeys with Cherry Pay and the smart
account is deployed with both passkeys on-chain (transfer rule + separate recovery rule):

```sh
SMART_ACCOUNT_TRANSFER_RULE_IDS=0 SMART_ACCOUNT_RECOVERY_RULE_ID=1 \
  npm run register-wallet -- --owner <wallet_accounts UUID> --address <C...>
# Docker: docker compose exec api npm run register-wallet -- --owner ... --address ...
```

The script reads the contract on Testnet and refuses to register unless:

- the executable WASM is the allowlisted hash;
- each selected rule has exactly one External signer using the pinned verifier and no policies;
  signer/policy IDs are hydrated from the contract when the rule getter omits them;
- the recovery rule holds a different passkey (different credential and public key);
- every on-chain passkey is a credential the owner registered with Cherry Pay, with identical key data.

It stores the policy fingerprint and never overwrites an existing row.

## 2. Enable payments

Set in `.env` (see `.env.example`) and restart the API:

| Variable | Meaning |
| --- | --- |
| `PAYMENT_RELAYER_SECRET` | Funded **Testnet** sponsor secret that pays fees. Never commit it. |
| `PAYMENT_START_LEDGER` | Ledger to start transfer-event monitoring from (e.g. deployment ledger). |
| `SMART_ACCOUNT_TRANSFER_RULE_IDS` | Comma-separated rule IDs committed into the transfer digest. |
| `SMART_ACCOUNT_RECOVERY_RULE_ID` | Rule holding the independent backup passkey. Required for payments. |

On startup every registered wallet is re-read on-chain; any mismatch (policy drift, missing
recovery, unowned signer, wrong code) stops the API instead of serving payments.
The log line `Payment runtime {"paymentsEnabled":true}` confirms the runtime is active.
