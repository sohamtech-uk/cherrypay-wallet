# Wallet payment experience

This release keeps the existing passkey session, Testnet C-wallet, exact payment review and durable recovery APIs. Wallet and Business are two views of the same authenticated wallet, not new account roles or separate balances.

## Screen review

| Component | Result |
| --- | --- |
| Application shell | Compact Cherry Wallet header, a single network badge, five primary destinations, settings shortcut, and small help/privacy footer. Desktop has an invoice shortcut; mobile uses a five-item bottom bar. Existing marketing header/footer components remain available but no longer surround payment screens. |
| Sign-in and onboarding | One sign-in card rather than sign-in plus disconnected-screen errors. The requested route stays open through authentication, including invoice checkout. Automatic deployment and funding progress retain their existing states. |
| Wallet dashboard | Exact indexed balance, hide/reveal, send/receive actions, wallet address, latest verified activity and automatic reads every 15 seconds. Old snapshot timestamps and refresh errors remain visible. Connected wallets still see the one-time 10,000 Testnet XLM funding action until confirmed. |
| Payment follow-up | Unresolved recent attempts stay actionable. Confirmation without verification is still unresolved. Status reads never prepare, approve, cancel or submit payments. |
| Business dashboard | Latest invoice collection totals, outstanding balance, unmatched receipts, invoice deep links and payroll entry. Metrics explicitly describe the latest API page, including expired invoices; they are not all-time revenue or fiat accounting. |
| Send | Details → Review → Status, shorter form guidance and exact recipient/amount/fee review. A repeat-payment link prefills only the recipient; amount and passkey approval are always fresh. Existing unknown-outcome locks and server-authorized reset remain intact. |
| Receive | Address and QR are primary. C-address/SAC compatibility and Testnet restrictions remain visible; longer instructions are expandable. Invoice QR action distinguishes address-only receipts from automatic invoice matching. |
| Activity | Verified transfers first when available, separate payment attempts, page-scoped direction/search filters, expandable addresses and reference IDs, exact CSV export of displayed verified owned transfers. Formula-like CSV cells are escaped. |
| Invoices | Explicit new-invoice form, loaded-invoice status filter, deep links from Business, focus on the selected invoice, and expandable manual reconciliation. Evidence note and explicit confirmation remain required for allocation. |
| Invoice checkout | Existing public invoice terms, recipient, amount, expiry, and owner-supplied merchant-name notice remain. Signing in does not lose the invoice. |
| Profile and security | Account, wallet, funding, passkeys and session remain separate sections. Secondary tools move to an expandable area. Primary-passkey loss and incomplete on-chain recovery warnings remain. |
| Payroll | Reachable from Business and settings. Existing exact per-recipient approval, partial completion, and unresolved-payment rules remain. Shared form/spacing styles are simplified. |
| Cross-chain / recipient checks | Secondary tools only. Existing network/capability gates and unsupported-coverage warnings remain; no new integration is activated. |

## Verification and limits

Frontend tests cover returning-user navigation, initial wallet setup, exact values, ownership, stale balance reads, unknown payment outcomes, invoice QR/reconciliation, dashboard funding, filtered exports and page-scoped totals. Mocked tests are not evidence of a new live signed Testnet payment. No backend, schema, contract, private-key or funding-limit changes are part of this UI release.

CSV exports contain only the displayed verified transfers on the current history page. They include transfer ID, network, transaction hash and invoice payment-request ID where present. No CSV file is automatically uploaded or sent elsewhere. Business metrics are XLM receipt summaries, not tax, revenue-recognition or fiat-conversion advice.

Rollback is the prior web image; existing APIs and database remain compatible. This branch builds on the invoice implementation in PR #66 and should be reviewed after or together with that dependency.
