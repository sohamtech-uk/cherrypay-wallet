# P0 secure passkey enrollment — implementation and validation status

## Implemented in PR #14
- Server-generated account IDs and WebAuthn user IDs; RP ID, origin and user-verification enforcement.
- MySQL InnoDB persistence of accounts, credentials, one-time expiring challenges and hashed bearer sessions.
- Initial enrollment uses a per-account MySQL InnoDB `SELECT ... FOR UPDATE` lock. Two simultaneous first-enrollment verifications cannot register competing credentials.
- Backup credential enrollment requires an authenticated session for the same account. Enrollment options and verification bind the session token hash to the challenge.
- Authentication verifies the stored credential and updates its signature counter inside the same account-locked transaction. Concurrent authentications serialize; counter rollback fails.
- Basic per-IP, per-endpoint development rate limiting (10 requests per minute per process).
- Wallet deployment remains disabled; Stellar network is Testnet only.

## Remaining verification and production gates
- **No tests/builds have been executed against this branch yet.** Test real passkey enrollment, backup enrollment, replay, parallel enrollment and authentication, session expiry and restart persistence.
- Per-process rate limiting is not sufficient for multi-replica deployments; replace with shared Redis/DB-backed rate limiting and an ingress-level policy.
- Replace ad-hoc schema creation with versioned migrations, establish DB credentials/rotation and encrypted backup policies, and add audited events.
- The API currently returns bearer tokens to the frontend. Define a hardened BFF/session storage strategy before production; do not store tokens in localStorage.
- Initial account creation can leave abandoned rows; add expiry/garbage collection. Authentication still uses a known account ID rather than discoverable credentials.
- Review challenge consumption semantics for failed verifications, denial-of-service resistance, security response headers and dependency audit.
- **No Stellar smart-account deployment, on-chain WebAuthn authorization, on-chain backup signer or independent recovery exists yet.** Do not represent backup-passkey enrollment as on-chain recovery.

This PR must remain draft until typecheck, Docker integration tests and a security review pass.

MySQL 8.4 replaces PostgreSQL for local development. Previous PostgreSQL volumes are not automatically migrated. Validate Docker startup, API typecheck, and concurrency tests before merge.

## Conditional startup SQL
- The API reads `apps/api/sql/001_wallet_schema.sql` on startup. Dockerfile copies this file into the API image.
- It queries `information_schema.TABLES` for the four wallet tables and skips DDL if all exist; otherwise it runs `CREATE TABLE IF NOT EXISTS` statements.
- The dedicated `DB_NAME` database must already exist and be accessible. Startup does not create databases or modify Cherry Money's existing schema.
- This is bootstrap-only schema creation, not a versioned migration system: existing tables are not altered, and future schema changes require migrations.
- Verify first startup, repeated startup, partial schema and missing database behavior locally. No Docker/MySQL integration tests have been run in this session.
