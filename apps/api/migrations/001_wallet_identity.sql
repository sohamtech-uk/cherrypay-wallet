-- Cherry Pay app database (PostgreSQL 17). Do not use wallet-backend's internal schema.
CREATE TABLE wallet_accounts (
  id TEXT PRIMARY KEY,
  webauthn_user_id TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE wallet_credentials (
  id TEXT COLLATE "C" PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES wallet_accounts(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX wallet_credentials_account_idx ON wallet_credentials(account_id);
CREATE TABLE wallet_challenges (
  id UUID PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES wallet_accounts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('register_initial','register_backup','authenticate')),
  challenge TEXT NOT NULL,
  session_hash TEXT COLLATE "C",
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX wallet_challenges_expires_idx ON wallet_challenges(expires_at);
CREATE TABLE wallet_sessions (
  token_hash TEXT COLLATE "C" PRIMARY KEY CHECK (length(token_hash) = 64),
  account_id TEXT NOT NULL REFERENCES wallet_accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX wallet_sessions_expires_idx ON wallet_sessions(expires_at);
