-- Opt-in lookup: never reveal an unverified account or unverified smart wallet.
-- Existing accounts remain private. A passkey login does not verify mailbox ownership.
ALTER TABLE wallet_accounts ADD COLUMN email_payments_enabled BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX wallet_accounts_receivable_email_idx
  ON wallet_accounts(id) WHERE email_payments_enabled = TRUE AND email_verified_at IS NOT NULL;
