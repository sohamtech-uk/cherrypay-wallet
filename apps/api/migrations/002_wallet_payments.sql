-- Durable B3-B7 contract; wallet provisioning remains gated on B1/B2 authorization.
CREATE TABLE wallet_onchain_accounts (
  id TEXT COLLATE "C" PRIMARY KEY,
  owner UUID NOT NULL REFERENCES wallet_accounts(id),
  network TEXT NOT NULL DEFAULT 'TESTNET' CHECK (network = 'TESTNET'),
  address TEXT COLLATE "C" NOT NULL UNIQUE,
  policy TEXT NOT NULL,
  routes JSONB NOT NULL DEFAULT '["classic"]'::jsonb,
  created_at BIGINT NOT NULL CHECK (created_at > 0)
);
CREATE INDEX wallet_onchain_owner_idx ON wallet_onchain_accounts(owner);

CREATE TABLE wallet_payment_attempts (
  id TEXT COLLATE "C" PRIMARY KEY,
  wallet_id TEXT COLLATE "C" NOT NULL REFERENCES wallet_onchain_accounts(id),
  idempotency_key TEXT COLLATE "C" NOT NULL,
  request_digest TEXT NOT NULL,
  intent JSONB NOT NULL,
  source_address TEXT NOT NULL,
  policy TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing','awaiting_approval','authorizing','ready','pending','unknown','confirmed','failed','rejected')),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  prepared JSONB,
  signed_xdr TEXT,
  transaction_hash TEXT,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  event_id TEXT COLLATE "C",
  failure_code TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  UNIQUE (wallet_id, idempotency_key)
);
CREATE INDEX wallet_attempts_wallet_sort_idx ON wallet_payment_attempts(wallet_id,created_at DESC,id DESC);
CREATE INDEX wallet_attempts_unresolved_idx ON wallet_payment_attempts(status,lease_until);
CREATE TABLE wallet_relayer_locks (
  id TEXT COLLATE "C" PRIMARY KEY,
  attempt_id TEXT COLLATE "C" REFERENCES wallet_payment_attempts(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE wallet_transfer_events (
  id TEXT COLLATE "C" PRIMARY KEY,
  transaction_hash TEXT NOT NULL,
  ledger BIGINT NOT NULL CHECK (ledger > 0),
  operation_index BIGINT NOT NULL CHECK (operation_index >= 0),
  event_index BIGINT NOT NULL CHECK (event_index >= 0),
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  amount_stroops NUMERIC(20,0) NOT NULL CHECK (amount_stroops > 0),
  closed_at BIGINT NOT NULL
);
CREATE INDEX wallet_events_sender_order_idx ON wallet_transfer_events(from_address,ledger DESC,id DESC);
CREATE INDEX wallet_events_recipient_order_idx ON wallet_transfer_events(to_address,ledger DESC,id DESC);
CREATE TABLE wallet_balance_snapshots (
  address TEXT COLLATE "C" PRIMARY KEY,
  amount_stroops NUMERIC(20,0) NOT NULL CHECK (amount_stroops >= 0),
  ledger BIGINT NOT NULL CHECK (ledger > 0),
  updated_at BIGINT NOT NULL
);
CREATE TABLE wallet_monitor_cursors (
  id TEXT COLLATE "C" PRIMARY KEY,
  cursor TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
