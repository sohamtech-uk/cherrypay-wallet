-- Durable, email-owned Testnet C-wallet deployment state. No on-chain deployment is implied.
CREATE TABLE wallet_deployment_jobs (
 account_id TEXT PRIMARY KEY REFERENCES wallet_accounts(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'AWAITING_PASSKEY' CHECK (status IN ('AWAITING_PASSKEY','PENDING','DEPLOYING','SUBMITTED','CONFIRMED','VERIFYING','ACTIVE','RETRYABLE_FAILURE','FAILED')),
 contract_address TEXT UNIQUE,
 transaction_hash TEXT UNIQUE,
 attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
 lease_token TEXT,
 lease_until TIMESTAMPTZ,
 retry_after TIMESTAMPTZ,
 failure_code TEXT,
 last_transition_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK ((status NOT IN ('SUBMITTED','CONFIRMED','VERIFYING','ACTIVE')) OR transaction_hash IS NOT NULL),
 CHECK ((status NOT IN ('CONFIRMED','VERIFYING','ACTIVE')) OR contract_address IS NOT NULL),
 CHECK ((status <> 'ACTIVE') OR (transaction_hash IS NOT NULL AND contract_address IS NOT NULL))
);
CREATE INDEX wallet_deployment_ready_idx ON wallet_deployment_jobs(status,retry_after,lease_until);
CREATE TABLE wallet_deployment_events (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 account_id TEXT NOT NULL REFERENCES wallet_accounts(id) ON DELETE CASCADE,
 from_status TEXT,
 to_status TEXT NOT NULL,
 event_code TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX wallet_deployment_events_account_idx ON wallet_deployment_events(account_id,id DESC);
