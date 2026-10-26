-- Direct Friendbot grants have no application-signed envelope or treasury key.
-- Keep migration 011 and its historical receipts intact; never reissue those grants.
CREATE TABLE wallet_friendbot_funding (
  account_id TEXT PRIMARY KEY REFERENCES wallet_deployment_jobs(account_id),
  address TEXT NOT NULL UNIQUE CHECK (address ~ '^C[A-Z2-7]{55}$'),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK(status IN ('PENDING','SUBMITTED','FUNDED','FAILED','REVIEW_REQUIRED')),
  amount_stroops TEXT NOT NULL DEFAULT '100000000000' CHECK(amount_stroops='100000000000'),
  request_started_at TIMESTAMPTZ,
  start_ledger BIGINT CHECK(start_ledger>0),
  transaction_hash TEXT UNIQUE CHECK(transaction_hash ~ '^[a-f0-9]{64}$'),
  ledger BIGINT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  failure_code TEXT,
  CHECK(status='PENDING' OR (request_started_at IS NOT NULL AND start_ledger IS NOT NULL)),
  CHECK(status<>'FUNDED' OR (transaction_hash IS NOT NULL AND verified_at IS NOT NULL AND ledger>start_ledger))
);
