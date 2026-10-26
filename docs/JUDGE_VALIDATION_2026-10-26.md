# Judge-readiness validation — 26 October 2026

This records work on `feat/genesis-judge-readiness`, based on `develop` commit `43c20bf7c9cbeba18606e3d966d8d3c626307afd`. It is not a live-payment acceptance report. See the linked PR for the final branch commit and CI results.

## Local automated checks

- Web production build and ESLint: passed. Vite still warns about the large entry bundle (approximately 417 kB gzip); measure real-device cold-load performance before claiming a fast mobile experience.
- Web tests: **150 passed**, including invoice keyboard review/approval/status/verified-receipt gating and interrupted-approval recovery. These use mocked payment services.
- API typecheck: passed. API tests: **261 passed; 63 database-dependent tests skipped locally**. Required database coverage must pass in PostgreSQL CI.
- API schema export: passed with no changes to the checked-in payment schema subset.
- Read-only checker tests: **7 passed**.
- Documentation relative links and whitespace checks: passed.
- Production containers and PostgreSQL integration: delegated to the repository's CI jobs; do not infer success from local unit tests. No Docker daemon or local PostgreSQL was used for this run.

## Public deployment observation

GET-only probe against `https://wallet.cherrymoney.co.uk`, completed **2026-10-26 09:47 UTC**, before deployment of this change:

| Check | Observation |
| --- | --- |
| Liveness / readiness | Healthy, ready, Testnet |
| Payment runtime | `/health` reports deployment and payments enabled |
| Smart-account capabilities | Reports spending disabled and lacks the new runtime-scope fields; disagrees with health |
| OpenAPI | `/api/v1/openapi.json` returns HTTP 404; latest developer API is not available on that deployment |
| Invoice route | Unknown invoice returns the expected typed 404 error |
| Aurora | Testnet funding disabled, as expected |
| Web shell / JavaScript | Root, developer and invoice-link shells respond; built JS asset available. This is not rendered-page or usability evidence. |

**Result: deployment readiness check fails.** The contradictory capability report is fixed in this PR; matching API/web images still need deployment. Do not use the bootstrap deployment script to overwrite an activated runtime's configuration. Preserve the deployment's existing signer, relayer, database and primary-payment configuration when updating images, then rerun the probe and record the actual image/revision.

## Not executed

No physical passkey ceremony, transaction submission, live receipt verification, invoice settlement, independent recovery, mobile/screen-reader usability session or judge portal submission was performed in this validation. Those cases remain `NOT_RUN` in the [acceptance plan](JUDGE_TEST_PLAN.md).
