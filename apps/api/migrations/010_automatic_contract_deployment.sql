-- Additive only: never edit migration 009 after it has been applied.
-- Deployment evidence does not activate a payment wallet or certify backup recovery.
ALTER TABLE wallet_deployment_jobs
  ADD COLUMN descriptor JSONB,
  ADD COLUMN signed_xdr TEXT,
  ADD COLUMN expires_at BIGINT,
  ADD COLUMN confirmed_ledger BIGINT,
  ADD COLUMN signer_rule_id INTEGER,
  ADD COLUMN binding_verified_at TIMESTAMPTZ,
  ADD COLUMN lease_token UUID,
  ADD COLUMN lease_until TIMESTAMPTZ,
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD CONSTRAINT deployment_descriptor_network CHECK (descriptor IS NULL OR descriptor->>'network' = 'TESTNET'),
  ADD CONSTRAINT deployment_signed_checkpoint CHECK (signed_xdr IS NULL OR (descriptor IS NOT NULL AND transaction_hash IS NOT NULL AND expires_at IS NOT NULL)),
  ADD CONSTRAINT deployment_verified_binding CHECK (binding_verified_at IS NULL OR (status IN ('CONFIRMED','ACTIVE') AND confirmed_ledger > 0 AND signer_rule_id >= 0));

-- Dedicated deployment fee source: a durable reservation survives process death.
-- An unresolved signed transaction keeps the slot even after its worker lease expires.
CREATE TABLE wallet_deployment_sponsors (
  public_key TEXT COLLATE "C" PRIMARY KEY,
  account_id TEXT UNIQUE REFERENCES wallet_deployment_jobs(account_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX wallet_one_unresolved_deployment_per_sponsor
  ON wallet_deployment_jobs ((descriptor->>'deployerPublicKey'))
  WHERE signed_xdr IS NOT NULL AND status NOT IN ('CONFIRMED','FAILED','ACTIVE');
CREATE INDEX wallet_deployment_pending_idx ON wallet_deployment_jobs(next_attempt_at,created_at)
  WHERE status IN ('PENDING','SUBMITTED');
