CREATE TABLE wallet_classic_challenges (
  account_id UUID PRIMARY KEY REFERENCES wallet_accounts(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL CHECK (public_key ~ '^G[A-Z2-7]{55}$'),
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
