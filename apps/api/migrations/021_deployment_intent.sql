-- Record a deterministic, signed deployment envelope before broadcasting.
ALTER TABLE wallet_deployment_jobs
 ADD COLUMN intent_hash TEXT UNIQUE,
 ADD COLUMN signed_envelope TEXT,
 ADD COLUMN envelope_hash TEXT,
 ADD COLUMN broadcast_started_at TIMESTAMPTZ,
 ADD COLUMN last_reconciled_at TIMESTAMPTZ,
 ADD CONSTRAINT deployment_intent_pair CHECK ((intent_hash IS NULL) = (signed_envelope IS NULL)),
 ADD CONSTRAINT deployment_envelope_pair CHECK ((envelope_hash IS NULL) = (signed_envelope IS NULL));
CREATE INDEX wallet_deployment_uncertain_idx ON wallet_deployment_jobs(status,broadcast_started_at)
 WHERE status IN ('DEPLOYING','SUBMITTED','CONFIRMED','VERIFYING');
