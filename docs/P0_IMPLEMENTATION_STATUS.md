# P0 implementation status — not production ready

This branch replaces development-only in-memory WebAuthn credentials and challenges with PostgreSQL storage, server-generated account identifiers, short-lived bearer sessions, one-time challenges and an authenticated backup-enrollment gate. Docker Compose starts PostgreSQL with a persistent volume.

## Remaining blocking work
- The initial enrollment flow must be made atomic with an account-row lock or unique initial-credential constraint. Two parallel registration challenges must never allow competing first credentials.
- Credential verification and counter updates must be wrapped in appropriate database transactions; concurrent WebAuthn assertions need replay-safe serialization.
- Rate limits, audit logging, session cookie/BFF strategy and CSRF controls, DB migrations, secret management, account enumeration protections, and end-to-end tests are outstanding.
- A smart-account contract and passkey P-256 on-chain authorization implementation have NOT been selected, audited or deployed. Wallet deployment remains explicitly disabled.
- Independent on-chain backup signer/recovery and native XLM SAC integration are NOT implemented.
- Local Docker build, TypeScript typecheck and automated tests have NOT been run against this branch.

Never deploy this branch publicly or represent it as a functioning self-custodial wallet. All Stellar configuration is Testnet-only.
