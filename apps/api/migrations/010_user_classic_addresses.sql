-- A separate classic G-address for each user; private keys must never be stored here.
CREATE TABLE wallet_classic_addresses (
  account_id UUID PRIMARY KEY REFERENCES wallet_accounts(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL UNIQUE CHECK (public_key ~ '^G[A-Z2-7]{55}$'),
  proof_nonce TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
