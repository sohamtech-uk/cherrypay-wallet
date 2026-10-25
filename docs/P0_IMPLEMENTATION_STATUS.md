# Passkey identity — PostgreSQL foundation status

## Implemented

- Server-generated account IDs and WebAuthn user IDs; verified relying-party hostname/origin and user verification.
- PostgreSQL-backed credentials, hashed sessions and expiring one-time challenges with `wallet_*` tables.
- Row-level `SELECT ... FOR UPDATE` account locks serialize initial enrollment and authentication counter updates.
- Backup enrollment requires the account's authenticated session; its challenge is bound to the session hash.
- One-time challenge rows are consumed transactionally; session revocation is persistent.
- Development-only process-local per-IP rate limiting (10 requests per minute); not adequate at scale.
- Testnet-only configuration; wallet deployment remains disabled.

## Remaining security and acceptance gates

- CI PostgreSQL integration tests must pass; additionally test real browser passkeys, account discovery, cross-device recovery, replay and parallel authentication.
- Implement shared/ingress rate limiting, session-cookie hardening, audit records, operational retention/cleanup and backup/restore policies.
- A passkey registered in PostgreSQL **does not establish an on-chain owner or signer policy**. Independently validate smart-account contract deployment, transaction-bound signature authorization, backup signer and recovery.
- Payment HTTP endpoints return 503 until secure signer/policy/runtime wiring passes B1/B2 gates.
- Any future schema changes require *new* migration files. Applied migration SHA-256 changes fail startup.

## Migration

No existing MySQL data exists, per project owner. PR #16 replaces the unused MySQL implementation with a fresh PostgreSQL 17 database. No export/import or dual-write mechanism is needed.
