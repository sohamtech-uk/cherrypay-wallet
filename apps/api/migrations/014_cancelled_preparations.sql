-- A durable cancellation prevents a delayed HTTP create from reviving an absent attempt.
-- Existing attempts and signed transactions are never deleted by reset.
CREATE TABLE wallet_cancelled_preparations (
  wallet_id TEXT COLLATE "C" NOT NULL REFERENCES wallet_onchain_accounts(id),
  idempotency_key TEXT COLLATE "C" NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(wallet_id,idempotency_key)
);
