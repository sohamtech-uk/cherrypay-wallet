# Working on Cherry Pay Wallet

Read [README.md](README.md), [the collaboration guide](docs/COLLABORATION.md)
and the existing implementation before editing. Start new work from `develop`,
preserve other contributors' changes, and use a focused pull request. Check the
actual code and acceptance evidence before describing a workshop phase as done.

## Stellar guidance

Use [skills.stellar.org](https://skills.stellar.org/) and
[Stellar ecosystem resources](https://github.com/stellar/ecosystem-resources)
for Stellar work. Read the skill for the task and its relevant companion files;
do not install every skill or add runtime dependencies merely because they are
listed. [Our ecosystem guide](docs/STELLAR_ECOSYSTEM_GUIDE.md) records reviewed
versions, provider checks and the current implementation boundary.

| Task | Skill to read |
| --- | --- |
| Wallet UI, transaction construction, passkeys | [dApp](https://skills.stellar.org/skills/dapp/SKILL.md) |
| Soroban accounts, authorization and recovery | [Smart contracts](https://skills.stellar.org/skills/smart-contracts/SKILL.md), including security guidance |
| XLM SAC, USDC and trustlines | [Assets](https://skills.stellar.org/skills/assets/SKILL.md) |
| Balances, transaction verification, history and indexing | [Data](https://skills.stellar.org/skills/data/SKILL.md) |
| Ecosystem integrations and SEP/CAP selection | [Standards](https://skills.stellar.org/skills/standards/SKILL.md), including `ecosystem.md` |
| Cross-chain payments | [Cross-chain](https://skills.stellar.org/skills/cross-chain/SKILL.md), then the selected rail's companion |

Verify network support, contract interfaces and SDK versions against primary
provider documentation and this repository's lockfiles. Catalog examples are
guidance, not proof of compatibility or a security audit. Keep the existing
[Stellar Build review reference](docs/MONAD_REUSE.md#stellar-references-used)
for authorization and failure-path reviews.

## Preserve the payment boundaries

- This deployment is Stellar Testnet-only. Keep Aurora funding disabled on
  Testnet; an API key does not create Testnet liquidity. Do not follow a guide's
  mainnet rehearsal example in this project.
- Passkey login and verified email identity do not authorize spending. Follow
  [the pinned account onboarding requirements](docs/SMART_ACCOUNT_KIT_TESTNET_ONBOARDING.md)
  for deployment, authorization, independent recovery and enablement evidence.
- Keep amounts as exact integer or decimal strings. Validate network, recipient,
  asset and amount against independently verified committed transaction data.
- PostgreSQL owns payment attempts, idempotency and durable monitoring cursors.
  An external indexer supplies read models; it cannot authorize or verify a
  payment by itself. Do not advance a cursor on failed ingestion or hide a
  retention gap by restarting at the latest ledger.
- Reconcile an uncertain submission before creating a replacement. Do not
  transfer Monad EVM signatures, ABIs, log identities or nonce assumptions into
  Soroban code.
- Keep keys in server-side secret configuration, out of browser bundles, logs,
  examples and commits.

## Verification

Use the checks for the changed area: API `npm run typecheck` and `npm test` in
`apps/api`; frontend `npm run build`, `npm run lint` and `npm test` in `apps/web`.
Follow the corresponding `.github/workflows/` configuration for database and
container checks. Documentation-only changes need link and diff checks, not a
new deployment. Report mocked tests separately from live Testnet evidence.
