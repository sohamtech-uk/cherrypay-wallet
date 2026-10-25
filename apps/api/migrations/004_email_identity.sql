-- Forward-only upgrade from the deployed UUID identity schema. Never edit 001-003:
-- their checksums are already persisted by existing installations.
-- Keep legacy IDs and all ownership references; no email can be inferred for them.
ALTER TABLE wallet_credentials DROP CONSTRAINT wallet_credentials_account_id_fkey;
ALTER TABLE wallet_challenges DROP CONSTRAINT wallet_challenges_account_id_fkey;
ALTER TABLE wallet_sessions DROP CONSTRAINT wallet_sessions_account_id_fkey;
ALTER TABLE wallet_onchain_accounts DROP CONSTRAINT wallet_onchain_accounts_owner_fkey;
ALTER TABLE wallet_transfer_approvals DROP CONSTRAINT wallet_transfer_approvals_owner_fkey;

ALTER TABLE wallet_accounts ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE wallet_credentials ALTER COLUMN account_id TYPE TEXT USING account_id::text;
ALTER TABLE wallet_challenges ALTER COLUMN account_id TYPE TEXT USING account_id::text;
ALTER TABLE wallet_sessions ALTER COLUMN account_id TYPE TEXT USING account_id::text;
ALTER TABLE wallet_onchain_accounts ALTER COLUMN owner TYPE TEXT USING owner::text;
ALTER TABLE wallet_transfer_approvals ALTER COLUMN owner TYPE TEXT USING owner::text;

ALTER TABLE wallet_accounts ADD CONSTRAINT wallet_accounts_id_check CHECK (id = lower(trim(id)));
ALTER TABLE wallet_accounts ADD COLUMN email_verified_at TIMESTAMPTZ;
ALTER TABLE wallet_credentials ADD CONSTRAINT wallet_credentials_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES wallet_accounts(id) ON DELETE CASCADE;
ALTER TABLE wallet_challenges ADD CONSTRAINT wallet_challenges_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES wallet_accounts(id) ON DELETE CASCADE;
ALTER TABLE wallet_sessions ADD CONSTRAINT wallet_sessions_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES wallet_accounts(id) ON DELETE CASCADE;
ALTER TABLE wallet_onchain_accounts ADD CONSTRAINT wallet_onchain_accounts_owner_fkey
  FOREIGN KEY (owner) REFERENCES wallet_accounts(id);
ALTER TABLE wallet_transfer_approvals ADD CONSTRAINT wallet_transfer_approvals_owner_fkey
  FOREIGN KEY (owner) REFERENCES wallet_accounts(id);

CREATE TABLE wallet_email_verifications (
  account_id TEXT PRIMARY KEY REFERENCES wallet_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
