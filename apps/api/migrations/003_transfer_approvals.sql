CREATE TABLE wallet_transfer_approvals (
  id TEXT COLLATE "C" PRIMARY KEY,
  owner UUID NOT NULL REFERENCES wallet_accounts(id),
  wallet_id TEXT COLLATE "C" NOT NULL REFERENCES wallet_onchain_accounts(id),
  attempt_id TEXT COLLATE "C" NOT NULL REFERENCES wallet_payment_attempts(id),
  session_hash TEXT COLLATE "C" NOT NULL REFERENCES wallet_sessions(token_hash) ON DELETE CASCADE,
  binding JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX wallet_transfer_approvals_expiry ON wallet_transfer_approvals(expires_at);
CREATE INDEX wallet_transfer_approvals_session_created ON wallet_transfer_approvals(session_hash, created_at);
