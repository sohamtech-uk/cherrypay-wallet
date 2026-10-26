-- Invoice identifiers are private application metadata, not Stellar memos.
CREATE TABLE wallet_invoice_requests (
  id TEXT COLLATE "C" PRIMARY KEY,
  wallet_id TEXT COLLATE "C" NOT NULL REFERENCES wallet_onchain_accounts(id),
  invoice_reference TEXT COLLATE "C" NOT NULL,
  merchant_name TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network = 'TESTNET'),
  asset_contract TEXT NOT NULL,
  destination TEXT NOT NULL,
  amount_stroops NUMERIC(20,0) NOT NULL CHECK (amount_stroops > 0),
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  request_digest TEXT NOT NULL,
  UNIQUE(wallet_id, invoice_reference)
);
CREATE INDEX wallet_invoice_list_idx ON wallet_invoice_requests(wallet_id,created_at DESC,id DESC);
ALTER TABLE wallet_payment_attempts ADD COLUMN payment_request_id TEXT COLLATE "C"
  GENERATED ALWAYS AS (intent->>'paymentRequestId') STORED REFERENCES wallet_invoice_requests(id);
CREATE INDEX wallet_invoice_attempts_idx ON wallet_payment_attempts(payment_request_id);
CREATE TABLE wallet_invoice_allocations (
  event_id TEXT COLLATE "C" PRIMARY KEY REFERENCES wallet_transfer_events(id),
  request_id TEXT COLLATE "C" NOT NULL REFERENCES wallet_invoice_requests(id),
  attempt_id TEXT COLLATE "C" UNIQUE REFERENCES wallet_payment_attempts(id),
  method TEXT NOT NULL CHECK (method IN ('checkout','manual')),
  actor TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX wallet_invoice_allocation_idx ON wallet_invoice_allocations(request_id);
CREATE TABLE wallet_invoice_outbox (
  id TEXT COLLATE "C" PRIMARY KEY,
  wallet_id TEXT COLLATE "C" NOT NULL REFERENCES wallet_onchain_accounts(id),
  request_id TEXT COLLATE "C" NOT NULL REFERENCES wallet_invoice_requests(id),
  event_id TEXT COLLATE "C" NOT NULL UNIQUE REFERENCES wallet_invoice_allocations(event_id),
  payload JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  delivered_at BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX wallet_invoice_outbox_pending_idx ON wallet_invoice_outbox(next_attempt_at) WHERE delivered_at IS NULL;
