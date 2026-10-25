-- Idempotent per-account Testnet deployment reservation. No private keys or unverified ownership claims.
CREATE TABLE wallet_deployment_jobs (
  account_id UUID PRIMARY KEY REFERENCES wallet_accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','AWAITING_PASSKEY','SUBMITTED','CONFIRMED','ACTIVE','FAILED')),
  contract_address TEXT UNIQUE,
  transaction_hash TEXT UNIQUE,
  failure_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (contract_address IS NULL OR contract_address ~ '^C[A-Z2-7]{55}$'),
  CHECK (transaction_hash IS NULL OR transaction_hash ~ '^[0-9a-f]{64}$'),
  CHECK (status NOT IN ('CONFIRMED','ACTIVE') OR (contract_address IS NOT NULL AND transaction_hash IS NOT NULL))
);
CREATE INDEX wallet_deployment_jobs_status_idx ON wallet_deployment_jobs(status);
