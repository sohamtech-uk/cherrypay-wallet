-- One checkout receipt per merchant invoice. Historical partial/multi-allocations
-- must be reviewed and reconciled explicitly before deployment: do not silently
-- delete a financial receipt or pick a winner.
DO $$
BEGIN
  IF EXISTS (
    SELECT request_id FROM wallet_invoice_allocations
    GROUP BY request_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SINGLE_INVOICE_SETTLEMENT_MIGRATION_REQUIRES_MANUAL_RECONCILIATION: multiple receipts on one invoice';
  END IF;
  IF EXISTS (
    SELECT 1 FROM wallet_invoice_allocations a
    JOIN wallet_invoice_requests r ON r.id=a.request_id
    JOIN wallet_transfer_events e ON e.id=a.event_id
    WHERE e.amount_stroops <> r.amount_stroops OR e.to_address <> r.destination
  ) THEN
    RAISE EXCEPTION 'SINGLE_INVOICE_SETTLEMENT_MIGRATION_REQUIRES_MANUAL_RECONCILIATION: partial, excess or wrong-destination receipt';
  END IF;
END $$;

-- The unique index protects allocations from parallel workers, manual assignments
-- and future codepaths, independently of application process locks.
CREATE UNIQUE INDEX wallet_invoice_one_receipt_idx
  ON wallet_invoice_allocations(request_id);

-- A direct SQL writer is not allowed to bypass the amount, destination or
-- Treasury/Friendbot checks. The stored invoice identifier is immutable.
CREATE FUNCTION wallet_invoice_exact_receipt_guard() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  invoice wallet_invoice_requests%ROWTYPE;
  transfer wallet_transfer_events%ROWTYPE;
BEGIN
  SELECT * INTO STRICT invoice FROM wallet_invoice_requests WHERE id=NEW.request_id FOR UPDATE;
  SELECT * INTO STRICT transfer FROM wallet_transfer_events WHERE id=NEW.event_id;
  IF invoice.network <> 'TESTNET'
    OR transfer.to_address <> invoice.destination
    OR transfer.amount_stroops <> invoice.amount_stroops
  THEN
    RAISE EXCEPTION 'INVOICE_EXACT_RECEIPT_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM wallet_friendbot_funding WHERE transaction_hash=transfer.transaction_hash)
     OR EXISTS (SELECT 1 FROM wallet_contract_funding WHERE transaction_hash=transfer.transaction_hash)
  THEN
    RAISE EXCEPTION 'SYSTEM_FUNDING_CANNOT_SETTLE_INVOICE';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER wallet_invoice_exact_receipt_before_insert
  BEFORE INSERT ON wallet_invoice_allocations
  FOR EACH ROW EXECUTE FUNCTION wallet_invoice_exact_receipt_guard();
