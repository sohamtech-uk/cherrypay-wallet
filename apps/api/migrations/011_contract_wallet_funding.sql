-- One user-requested Testnet allocation per owner and C-address.
CREATE TABLE wallet_contract_funding (
  account_id TEXT PRIMARY KEY REFERENCES wallet_deployment_jobs(account_id),
  address TEXT NOT NULL UNIQUE CHECK (address ~ '^C[A-Z2-7]{55}$'),
  source TEXT NOT NULL CHECK (source ~ '^G[A-Z2-7]{55}$'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SUBMITTED','FUNDED','FAILED')),
  amount_stroops TEXT NOT NULL DEFAULT '1000000000000' CHECK(amount_stroops='1000000000000'),
  signed_xdr TEXT,
  transaction_hash TEXT UNIQUE,
  expires_at BIGINT,
  ledger BIGINT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  failure_code TEXT,
  CHECK ((signed_xdr IS NULL AND transaction_hash IS NULL AND expires_at IS NULL) OR
    (signed_xdr IS NOT NULL AND transaction_hash ~ '^[a-f0-9]{64}$' AND expires_at>0)),
  CHECK(status='PENDING' OR signed_xdr IS NOT NULL),
  CHECK(status<>'FUNDED' OR (verified_at IS NOT NULL AND ledger>0))
);
-- An uncertain transaction reserves this source's sequence across restarts.
CREATE UNIQUE INDEX wallet_contract_funding_source_inflight ON wallet_contract_funding(source) WHERE status='SUBMITTED';
