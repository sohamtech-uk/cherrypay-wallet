-- Email is the primary key of the public identity; immutable UUID remains the wallet foreign key.
CREATE TABLE wallet_email_identities (
 email TEXT PRIMARY KEY,
 account_id UUID NOT NULL UNIQUE REFERENCES wallet_accounts(id) ON DELETE CASCADE,
 verified_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT wallet_email_identity_normalized CHECK (email = lower(trim(email)))
);
INSERT INTO wallet_email_identities(email,account_id,verified_at)
 SELECT email,id,email_verified_at FROM wallet_accounts WHERE email IS NOT NULL;
CREATE TABLE wallet_email_verifications (
 account_id UUID PRIMARY KEY REFERENCES wallet_accounts(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX wallet_email_verifications_expiry_idx ON wallet_email_verifications(expires_at);
