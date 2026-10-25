# Stellar integrations for Cherry Pay Wallet

Reviewed 25 October 2026 against `develop` at `e2c325c`. This guide applies
[Stellar ecosystem resources](https://github.com/stellar/ecosystem-resources/tree/0f0cb0d14ca2d03a7241c6c1177e6173c0bc7b44)
and [Stellar Skills](https://skills.stellar.org/) to the existing wallet.
The catalog and skills are development references, not runtime libraries.
This update adds guidance only: no indexer, bridge, contract or payment capability
is deployed or enabled by it.

## Reuse decisions

| Capability | Current implementation | Next integration boundary |
| --- | --- | --- |
| Passkey smart account | Smart Account Kit bindings plus a pinned OpenZeppelin account adapter; deployment and recovery acceptance remain gated | Complete the existing B1/B2 Testnet evidence before enabling native payments |
| Native XLM payments | Stellar SDK/RPC, application authorization, controlled fee relayer, PostgreSQL attempts and history | Retain independent committed-transaction verification and exact stroop amounts |
| Historical data | RPC polling with persistent PostgreSQL events and cursor; optional Wallet Backend client | Evaluate Goldsky Turbo for Stellar Testnet archive/backfill needs; compare with Wallet Backend before activation |
| Pay from another chain | Aurora integration exists but funding is blocked on Testnet | Circle CCTP V2 is a separate candidate for Base Sepolia USDC to Stellar Testnet USDC; it is not implemented here |
| Price data / reconciliation | No Chainlink price feed is required for native XLM transfers | Evaluate native Stellar Data Feeds if a priced settlement feature needs them; Monad CRE is a separate product/integration |
| Supplier payments, permissions, approvals and accounting | Cherry application/business boundaries | Keep custom; a chain indexer or bridge cannot decide business approval or mark the ledger paid |

The API currently pins `@stellar/stellar-sdk` 16.3.0 and
`smart-account-kit-bindings` 0.4.0. The frontend declares Stellar SDK `^14.0.0`;
its lockfile selects the resolved version. The full `smart-account-kit` SDK is
not installed. Do not equate the bindings package version with the selected
account contract version, or replace the existing adapter with an unverified
snippet from the catalog. See [account onboarding](SMART_ACCOUNT_KIT_TESTNET_ONBOARDING.md).

## Indexing: retain correctness while adding history

The [data skill](https://github.com/stellar/stellar-dev-skill/blob/e20f3529421830ee57fdbf9974e334816b05fe84/skills/data/SKILL.md)
recommends RPC for current state and a durable data pipeline for deeper history.
RPC retention is provider-specific: recent `getEvents` / `getTransaction` access
does not imply an archive. Deep `getLedgers` access requires a provider with the
appropriate data lake; the public SDF Testnet endpoint is not that archive.

Our worker discovers events through RPC and independently verifies committed
transaction metadata. PostgreSQL deduplicates canonical event identities and
persists the cursor. This preserves observed history, but does not prove complete
history across downtime beyond the RPC retention window or a Testnet reset.

[Goldsky's Stellar documentation](https://docs.goldsky.com/chains/stellar)
explicitly lists Turbo datasets for `stellar_testnet`, including events,
transactions and transfers, with PostgreSQL delivery. That makes Turbo a
candidate to evaluate, not an already configured service. Dataset versions,
historical coverage, access and pricing must be checked for the selected plan.
[The ecosystem indexer directory](https://github.com/stellar/ecosystem-resources/blob/0f0cb0d14ca2d03a7241c6c1177e6173c0bc7b44/indexers/providers.md)
also lists Mercury, SubQuery and OBSRVR; listing alone does not establish their
current Testnet coverage or compatibility with this wallet.

Before switching a history read path:

1. Pin the provider dataset/schema and Testnet configuration. Use separate
   indexer storage and credentials; do not grant access to payment-attempt,
   authentication or business-accounting tables.
2. Compare amounts, recipients, assets and event identities with independently
   verified Testnet transactions. Include contract-account transfers, duplicates
   and failed transactions; test pagination and crash/restart replay.
3. Persist ingestion coverage and lag. Detect a cursor older than the provider's
   retained data or a Testnet reset. Surface the gap and backfill it; never silently
   replace a recovery cursor with `latest`.
4. Preserve wallet-owner authorization, bounded queries and exact amounts. Keep
   settlement verification and uncertain-attempt recovery in the payment engine.

[Stellar Wallet Backend](STELLAR_WALLET_BACKEND.md) remains another optional,
separately deployed indexer. Its existing GraphQL client is not connected to the
wallet payment flow. Envio's Monad project cannot index Stellar by changing the
RPC URL; see [the reuse assessment](MONAD_REUSE.md).

## Cross-chain: a distinct Testnet implementation

The [cross-chain skill](https://github.com/stellar/stellar-dev-skill/blob/e20f3529421830ee57fdbf9974e334816b05fe84/skills/cross-chain/SKILL.md)
and [CCTP companion](https://github.com/stellar/stellar-dev-skill/blob/e20f3529421830ee57fdbf9974e334816b05fe84/skills/cross-chain/cctp.md)
identify native USDC burn/mint as a different rail from an intent swap.
[Circle lists Base and Stellar, including their official testnets](https://developers.circle.com/cctp/concepts/supported-chains-and-domains),
and publishes [Stellar Testnet contracts](https://developers.circle.com/cctp/references/stellar-contracts).
This supports evaluating Base Sepolia to Stellar Testnet, without relabeling
Aurora's mainnet route as Testnet or enabling it with the existing API key.

A future CCTP adapter needs its own durable attempt state and UI:

- Validate the source network, Circle-issued USDC, destination network and
  supported recipient type before burn authorization. Check classic-account
  trustlines and receiving capacity; reject unsupported destinations.
- Use the documented `CctpForwarder` flow and recipient encoding. Do not put a
  raw account key into a field interpreted as a contract address. Pin the Testnet
  deployment and verify all source/destination contract addresses independently.
- Keep USDC integer amounts exact across Base/CCTP's six decimals and Stellar's
  seven. Persist the reviewed fee terms and expected destination amount.
- Persist source transaction, message/nonce, attestation and destination
  transaction evidence. Resume after crashes without another burn; detect replay,
  expired attestations and uncertain outcomes. A source burn alone is not success.
- Verify destination mint/forward amount and recipient independently before
  confirming receipt. Separate pending, recoverable and failed outcomes in the UI.

Circle's managed **Forwarding Service** is not listed for Stellar. The on-chain
**CctpForwarder** contract is a different component; an implementation still
needs a destination transaction submitter and fee policy. No cross-chain transfer
was made as part of this resource review.

## Chainlink: verify the product, not only the brand

[Chainlink Data Feeds now document Stellar Testnet and Mainnet](https://docs.chain.link/data-feeds/stellar).
Their Stellar interface uses a Soroban proxy and feed identifier. This does not
make Monad EVM ABIs or a CRE workflow portable to Stellar. Add a price feed only
for a defined product requirement, with freshness, scale and failure handling;
keep it outside native XLM transfer confirmation.

## Implementation order and reference maintenance

1. Finish the existing smart-account deployment, passkey spending and independent
   backup recovery acceptance described in [the workshop status](WORKSHOP_PHASE_STATUS.md).
2. Exercise receive/send/history and uncertain-outcome recovery on Testnet.
3. Add archive/backfill coverage if the history requirements exceed RPC retention;
   validate an external indexer before changing the read path.
4. Implement the separate CCTP Testnet adapter and recovery tests before exposing
   funding. Keep Aurora's Testnet funding block in place.

Read the task-specific skills listed in [AGENTS.md](../AGENTS.md). This review used
`stellar/stellar-dev-skill` commit `e20f3529421830ee57fdbf9974e334816b05fe84`
(data, standards/ecosystem and cross-chain/CCTP) and ecosystem-resources commit
`0f0cb0d14ca2d03a7241c6c1177e6173c0bc7b44`. Recheck live provider documentation
before implementation; catalog snippets and capability tables can age. Community
skill inclusion is not a security audit. Keep the existing
[Stellar Build review guidance](MONAD_REUSE.md#stellar-references-used) as well.
