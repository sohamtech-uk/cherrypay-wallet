-- Immutable Testnet XLM disbursement runs. Each line uses the existing payment
-- engine; this table neither grants spending authority nor records settlement.
CREATE TABLE wallet_payroll_runs (
  id TEXT COLLATE "C" PRIMARY KEY,
  wallet_id TEXT COLLATE "C" NOT NULL REFERENCES wallet_onchain_accounts(id),
  reference TEXT COLLATE "C" NOT NULL,
  request_digest TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(wallet_id, reference)
);
CREATE INDEX wallet_payroll_runs_order_idx ON wallet_payroll_runs(wallet_id, created_at DESC, id DESC);
