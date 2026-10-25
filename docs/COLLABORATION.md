# Two-contributor workflow

## Roles
**Contributor A — frontend / UX**: `apps/web/`, UI components, wallet flows, accessibility and frontend tests.
**Contributor B — Stellar / security**: `apps/api/`, `packages/wallet-core/`, `contracts/`, relayer, transaction verification and backend tests.
**Both**: `packages/shared-types/`, API contract, security model, E2E tests, release/demo checklist. Ownership indicates lead responsibility, not exclusive access.

## Branches
- `main`: stable/reviewed
- `develop`: integration
- `feat/wallet-ui`: frontend work, branch from develop
- `feat/stellar-wallet-core`: wallet integration, branch from develop
- `docs/wallet-mvp-plan`: initial planning PR into develop

No direct commits to main/develop after initial bootstrap. Each contributor opens small PRs into develop; the other reviews. Do not merge failing CI. Resolve shared-type changes through a contract-first PR.

## Daily routine
- 15-minute sync: completed, next, blockers, interface changes.
- Every PR: problem, scope, screenshots or Testnet evidence, tests, security impact, rollback notes.
- Demo the integrated flow at each milestone.
- Track progress in GitHub issues; use the task descriptions in `docs/TASKS.md`.

## Definition of done
- Acceptance tests passed, errors handled, API documented, no secrets or private keys logged.
- No unverified payment marked successful.
- Unknown submission outcomes investigated before a replacement attempt.
- Another contributor reviews before merging.
