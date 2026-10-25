ALTER TABLE wallet_accounts ADD COLUMN email TEXT;
ALTER TABLE wallet_accounts ADD COLUMN email_verified_at TIMESTAMPTZ;
CREATE UNIQUE INDEX wallet_accounts_email_unique ON wallet_accounts(email) WHERE email IS NOT NULL;
