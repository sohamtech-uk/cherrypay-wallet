# Reuse from Monad Metropolis

Reviewed `sohamtech-uk/Monad-Metropolis` at
[`10d7bd3052200550937704b3d19d8c5deaa02009`](https://github.com/sohamtech-uk/Monad-Metropolis/tree/10d7bd3052200550937704b3d19d8c5deaa02009).
This is an implementation mapping, not a claim that the integrations have been
ported or deployed in this repository.

| Existing module | Reuse in CherryPay | Required change |
| --- | --- | --- |
| `packages/cherry-money-client` | Typed authenticated business-draft API boundary | Preserve business ownership and draft-only semantics; use exact decimal strings, bounded requests and redirect restrictions before importing |
| `cre/settlement-verifier/workflow.ts` | Independent settlement checks and reconciliation evidence | Replace `EVMClient`, registry ABI and `viem` address checks with verified Stellar transaction/event evidence; process durable cursors rather than only the latest settlement |
| `envio/src/handlers/CherrySettlementRegistry.ts` | Explicit payer/recipient/asset/amount mismatch diagnostics; daily and counterparty read models | Consume canonical Stellar event identities from our durable indexer; retain transactional deduplication before updating aggregates |
| `packages/envio-client` | Typed read-model parsing, request timeout and analytics view shape | Replace Monad GraphQL schema, hex addresses and AUSD asset assumptions; keep wallet history authenticated |
| `apps/mobile/src/mera/transferProgress.ts` | Observers cannot fail or rebroadcast a payment | Its session-only cache is presentation state; PostgreSQL attempts remain the recovery source |
| Mobile payment/recovery UI and tests | Status wording, failure scenarios, receipt/progress layout ideas | Adapt React Native components to the existing web UI, Stellar status meanings and keyboard accessibility |

Mera signing, Solidity contracts, EVM log positions, gas/nonce management, AUSD
decimals and 0x address normalization are chain-specific. They cannot authorize a
Soroban account or identify a native XLM SAC event. XLM uses seven decimal places;
amounts in our payment engine remain integer stroop strings.

The existing CRE workflow combines Envio, direct Monad registry reads and Cherry
Money drafts, then emits evidence. It does not mark accounting records paid. Keep
that boundary: future accounting mutations require a dedicated idempotent callback.
USD/AUSD equality cannot be reused for fiat/XLM reconciliation; a separately
approved, persisted FX quote would be needed.

Envio's current [network documentation](https://envio.dev/) lists EVM, Solana and
Fuel. The inspected indexer uses `evm.schema.json`, chain 10143 and EVM event ABIs;
changing its RPC URL to Stellar is not an integration. Retain our Stellar RPC and
PostgreSQL indexer for the MVP. The Chainlink workflow's HTTP/cron/business checks
are candidates for a later adapter; native CRE support must be verified for the
chosen product/version rather than inferred from support for another Chainlink
product.

Through workshop step 5, prioritize the existing receive/send/history flow and
actual Testnet acceptance. Reuse the business boundary and read-model patterns
when adding reconciliation/analytics, without adding Envio or CRE as payment-path
dependencies. No third-party tokens, deployments, signing keys or production
accounting changes were copied or activated.

## Stellar references used

- [Stellar dApp skill](https://github.com/stellar/stellar-dev-skill/blob/e20f3529421830ee57fdbf9974e334816b05fe84/skills/dapp/SKILL.md)
  and its smart-account companion: verify SDK/contract compatibility and keep
  authorization tied to the selected account model.
- [Stellar data skill](https://github.com/stellar/stellar-dev-skill/blob/e20f3529421830ee57fdbf9974e334816b05fe84/skills/data/SKILL.md):
  RPC for current state, persistent indexing, explicit history retention limits.
- [Stellar Build edge-case review](https://github.com/kaankacar/stellar-build/blob/989ae9b38a83e86f173cae96a2a81975c46a26bb/skills/methodology/review-edge-case-hunter/SKILL.md):
  trace changed authorization paths, malformed inputs, changed rules, RPC failure
  and snapshot boundaries before merging.
