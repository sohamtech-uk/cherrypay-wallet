# Verified-email Testnet payments and charge breakdown

The payment preview uses exact integer stroops (1 XLM = 10,000,000 stroops). The amount received is the selected native XLM transfer amount. The current Cherry Wallet native-XLM platform fee is zero. The network fee line is a **maximum sponsored fee allowance**, not a verified actual charge. The maximum wallet debit is the transfer amount plus any network fee paid by the wallet (zero when the relayer sponsors it).

Cherry Wallet does not calculate FX, payroll PAYE, NI, pension, or gross-to-net deductions. Cherry Money's payroll and accounting ledger remains responsible for those. Testnet XLM has no real-world monetary value.

## Private email recipient lookup

An email is only a convenient alias for an actual Stellar C-address. It is not spend authority. Before enabling email discovery, the recipient must prove ownership of their mailbox using the existing Microsoft Graph/Exchange verification sender and an eight-digit 15-minute code, then opt in in Profile. Only a confirmed, on-chain-bound Testnet smart wallet is eligible. The default for every account is undiscoverable.

A signed-in payer can use GET /api/v1/recipients/resolve?email=... to resolve an exact opted-in email. There is no public search, no partial matches, and no distinction in error messages between unknown, private and unready accounts. Lookup is rate-limited per account/IP. Email control plus on-chain wallet binding is not legal or KYC identity verification.

The Send form shows both email and the resolved actual C-address, amount and maximum network fee. It re-resolves before approval and refuses a changed mapping; the passkey signs the actual address and transaction. No signing keys or mailbox verification codes enter payment history or the Stellar network. Email is not a recovery credential for a lost primary signer.

## Configuration and acceptance

- Apply additive migration 016_verified_email_directory.sql before serving the release. Opt-in is false by default.
- Configure AZURE_MAIL_TENANT_ID, AZURE_MAIL_CLIENT_ID, AZURE_MAIL_CLIENT_SECRET and the existing EXCHANGE_MAIL_* sender settings. Mail failure leaves the email unverified.
- Verify two separate real mailboxes, passkeys and Testnet smart wallets. Test unknown, private, failed verification, rate-limited and on-chain-unbound accounts.
- Check exact amount/fee breakdown with both sponsor and wallet-funded quote types; no speculative FX or taxes.
- Confirm that a mapping change before approval blocks the transfer and retrying an uncertain attempt does not duplicate payment.
- Reconcile a real native XLM Testnet transfer against its committed event before claiming successful settlement.

Automated tests establish API and PostgreSQL invariants; live Exchange email delivery, actual Testnet transfer and hardware passkey evidence require separate deployment acceptance.