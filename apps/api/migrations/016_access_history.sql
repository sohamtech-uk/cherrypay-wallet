CREATE TABLE wallet_access_events (
  id UUID PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES wallet_accounts(id) ON DELETE CASCADE,
  session_hash TEXT UNIQUE REFERENCES wallet_sessions(token_hash) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address TEXT,
  user_agent TEXT NOT NULL DEFAULT '',
  latitude NUMERIC(4,1),
  longitude NUMERIC(4,1),
  CHECK (latitude BETWEEN -90 AND 90),
  CHECK (longitude BETWEEN -180 AND 180),
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);
CREATE INDEX wallet_access_owner_created ON wallet_access_events(account_id,created_at DESC,id DESC);
CREATE INDEX wallet_access_retention ON wallet_access_events(created_at);
