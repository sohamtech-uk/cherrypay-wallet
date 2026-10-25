# Cherry Pay Wallet — B1/B2 integration foundation

## Status
**Developer-only WebAuthn verification prototype**, not a deployable wallet. Passkey registration and authentication challenges are generated server-side and verified with WebAuthn RP ID, exact origin and user verification requirements. Registration of a second credential is possible only for a known account ID in this prototype; **this is not a secure recovery or account-linking authorization model**.

There is no on-chain smart account creation, no signed Stellar transaction, no wallet address assignment, and no mainnet. The API explicitly reports `walletDeploymentEnabled: false`. Never treat a successful passkey registration as ownership of an on-chain account.

## Run
```sh
cd apps/api
npm install
npm run typecheck
npm test
npm run dev
```
Set `WALLET_ORIGIN=http://localhost:5173` and `WEBAUTHN_RP_ID=localhost` for local development (defaults match). All POST requests require the exact Origin header. The API binds to localhost only.

## Security blockers before any deployment
1. **Authentication and authorization**: an account ID is not identity proof. Integrate Cherry Money identity/session or independent wallet login; require an authenticated session and existing credential approval before adding a second passkey. Do not expose enrollment to arbitrary account IDs.
2. **Durable encrypted persistence**: in-memory credential/challenge store resets on restart; use transactional database, unique credential constraints, replay prevention, encryption and rate limiting.
3. **On-chain authorization**: evaluate Stellar Smart Account Kit and OpenZeppelin account contract compatibility, pin verified versions, validate WebAuthn P-256 signature support and contract deployment on Testnet. Passkey login is not authorization to spend.
4. **Wallet recovery**: independently registered backup credential, verified signer policy, lost-device drill, no provider unilateral recovery.
5. **Operations**: TLS, CSRF protections, session binding, telemetry without secrets, denial-of-service controls and security review.

## Scope / ownership
Contributor B owns this backend foundation; Contributor A's UI must not enable create-wallet until these blockers are resolved. Keep all testing on Stellar Testnet.


## B3–B7 payment backend

The native-XLM payment engine, asynchronous MySQL repository contract, API schemas, relayer, verification/indexing and retry worker are implemented under `src/payments`. Read [PAYMENT_BACKEND.md](../../docs/PAYMENT_BACKEND.md) for the composition contract, endpoint specification, persistence and recovery rules. The default server returns 503 on payment routes until a verified B1/B2 session and on-chain signer-policy adapter are supplied.

Use Node 22+ and `npm ci`. Run `npm run typecheck`, `npm test` and `npm run schema`. Existing development-only passkey endpoints are not payment authentication. Do not enable spending before the B1/B2 deployment/recovery and live Testnet integration gates pass.

MySQL persistence is owned by Sunil. This PR injects `PaymentRepository` and includes no alternative database implementation. See [MYSQL_PAYMENT_CONTRACT.md](../../docs/MYSQL_PAYMENT_CONTRACT.md) for the transaction/locking handoff and pending MySQL integration tests.
