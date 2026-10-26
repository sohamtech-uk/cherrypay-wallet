-- Persist the initial history boundary instead of moving it on API restarts.
ALTER TABLE wallet_monitor_cursors ADD COLUMN start_ledger BIGINT CHECK(start_ledger>0);
