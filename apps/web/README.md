# Cherry Pay Wallet UI

Stellar Testnet wallet UI with passkey profiles, authenticated wallet discovery,
indexed balances, receive instructions, payment review/approval and verified history.

## Run

```sh
cd apps/web
npm ci
npm run dev
npm test
npm run lint
npm run build
```

The browser uses same-origin `/api/v1` endpoints. Configure the Vite proxy and the
API's exact `WALLET_ORIGIN` as described in
[Payment UI integration](../../docs/PAYMENT_UI_INTEGRATION.md).

## Profiles and wallet activation

Create a passkey profile in the connection panel and keep the public account ID.
The UI remembers only that ID in localStorage; session tokens stay in memory.
An interrupted registration can be recovered by signing in with the same ID and
the created passkey. Additional enrollment requires an authenticated session.
New passkeys use ES256/P-256 for compatibility with the selected Stellar verifier.

Enrollment does not deploy a wallet, install an on-chain signer or prove recovery.
The pilot operator must deploy and approve the account and independent recovery
configuration, then link it using the trusted provisioning CLI. After activation,
reconnect: one owned wallet opens automatically; multiple wallets require selection.
See [Testnet startup](../../docs/TESTNET_STARTUP.md).

The overview reads indexed balances and verified transfers from the connected
wallet. Amounts retain all seven XLM decimal places. Stale/missing snapshots and
partial failures remain explicit, with refresh recovery. Classic watch-only lookup
is separate and grants no spending authority.

Receive QR/copy appears only for a verified supported route. Send reviews exact
amounts and maximum fees and uses the configured WebAuthn transaction approval API.
Unknown outcomes retain their persisted attempt key; checking status never resends.
Sessions expire after at most 30 minutes; refresh requires a new passkey sign-in.
No Mainnet fallback, browser-held relayer secret or fabricated transaction is used.

Automated tests cover enrollment cancellation/lost responses, session replacement,
expiry races, exact amounts, stale balances, verified receipts and payment recovery.
Actual device recovery and end-to-end Testnet payment acceptance remain required.
