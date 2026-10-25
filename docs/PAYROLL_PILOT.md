# Testnet payroll disbursement pilot

The `/payroll` screen creates immutable, PostgreSQL-backed XLM pay runs of up to
50 recipients. This is payment orchestration, not gross-to-net payroll, tax,
pension, payslip or regulatory reporting software. All amounts use integer
stroops; no FX conversion, rounding, scheduling or background signing occurs.

## User flow

1. Connect an already provisioned, verified Testnet smart wallet.
2. Enter a unique run reference and one `reference,address,XLM amount` per line.
   Use internal references, not employee names or other personal information.
   Only personal wallets that do not require a memo are supported.
3. Save the run. Saving does not create, sign or submit transfers.
4. Review one recipient. The server assigns a stable key derived from the saved
   run and line; the existing payment engine prepares the exact transfer.
5. Check the displayed amount, destination and maximum sponsored fee, then
   approve with a passkey. Each recipient requires separate approval.
6. Refresh the run to observe independently verified receipts. Finish or resolve
   the current payment before preparing another; the existing global relayer
   reservation prevents conflicting source sequences.

The run reference is unique per wallet. Retrying the same reference and exact
payload recovers the same run, including across browser reloads. Changed data
with that reference returns `PAY_RUN_REFERENCE_CONFLICT`. Rows are immutable.
Line attempts remain attached after failed, rejected or unknown outcomes;
there is no automatic replacement payment, top-up, batch approval or retry key.
A new run is a new payment instruction and must not be used to replace uncertain
payments. Partial settlement is possible and explicitly displayed.

Balances are checked by the existing payment engine per transfer; saving a run
neither reserves funds nor promises that every line can settle. The existing
maximum sponsored fee is a limit, not the actual charged fee. Recipient C-addresses
still require the existing current-policy and independent-backup checks.

## Deployment and rollback

Apply migration `004_payroll_runs.sql` using the existing migration runner before
serving this build. No new package or secret is required. Runtime activation
continues to depend on the configured payment manifest, relayer and acceptance
gates. This change does not activate Aurora or deploy any wallet.

The four payroll endpoints are documented in `payments.openapi.json`. They use
verified session ownership and trusted mutation origins. Existing approval,
reconciliation, leases and idempotency remain authoritative. Pay runs contain no
signing credentials. The list is paginated in pages of 20; each detailed run is
bounded to 50 recipients.

Roll back application images if necessary, retaining the new table and existing
payment records. Do not delete run references or attempt keys while any payment
is unresolved. The migration is additive and checksum-tracked.

## Acceptance

Automated coverage checks duplicate concurrent creates, changed-payload conflict,
owner isolation, exact large amounts, pagination, restart recovery, relayer
serialization, pending/unknown outcomes and browser approval-timeout recovery.
Database cases run against PostgreSQL in CI. Mocks are not live settlement proof.

Before demonstrating an actual paid run, complete deployment and independent
backup recovery for the sender and any C-address recipients, fund with Testnet
XLM, then run two separately approved payments and match each receipt to the
saved line. Repeat after a browser reload and RPC timeout. Do not claim payroll
completion unless every line is confirmed and independently verified.
