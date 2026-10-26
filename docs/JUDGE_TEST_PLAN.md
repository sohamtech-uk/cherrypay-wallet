# Judge acceptance and UX test plan

Target: Genesis — Stellar Composed, plus the team's two reported UX prize opportunities. Suggested owners: **Srini** for product/UX and submission; **Sunil** for Stellar/API and deployment. These assignments are proposed, not confirmation that anyone has run a case.

## Evidence rules

Use only Stellar Testnet and disposable demo identities. Record `PASS`, `FAIL`, `BLOCKED` or `NOT_RUN`; record the exact commit, deployed image/revision, time, device/browser, tester and evidence link. Automated fixtures prove code behaviour under those fixtures, not real biometric approval, chain settlement or customer adoption. A skipped database test is not a pass. Never store secrets, raw credentials, session tokens or private email addresses in public evidence.

The rehearsal begins with two separately owned demo wallets: merchant and payer. Confirm each wallet's on-chain signer binding and supported receive route. Use a small amount such as 0.1 Testnet XLM, with sufficient payer balance and an available sponsor. Do not use a G-address when the active service advertises only contract destinations. Do not reset a real pending attempt, delete database records or fund any mainnet route to make a demo appear successful.

## Run order and release gates

| Gate | Owner | Procedure | Pass condition / evidence |
| --- | --- | --- | --- |
| G1 — code/contract checks | Sunil | Web build/lint/tests; API typecheck/tests/schema; PostgreSQL integration CI; production-container CI | All relevant jobs pass on the PR merge commit; no unexplained skipped required tests |
| G2 — deployed public checks | Sunil | Run the GET-only command below against the intended deployment | JSON report passes; deployment revision recorded separately; health and capability flags agree |
| G3 — live invoice payment | Both | Run P1–P6 below with physical passkeys and separate sessions | Correct receipt independently verified; exact invoice allocation, no duplicate payment |
| G4 — UX acceptance | Srini | Run U1–U9, prioritising mobile and keyboard before recording | No blocker prevents understanding, authorization, status checking or receipt access |
| G5 — judge package | Srini | Follow the submission checklist in the judge guide | Video, deck, source and answers agree; links work signed out; submission receipt captured |

**No-go:** wrong network/recipient/amount, spending without approval, duplicate submission, unverified success, leaked secrets, or an inaccessible approval/status action. A read-only smoke pass cannot waive G3 or G4. Independent recovery is a separate claim gate; failing or omitting it must leave recovery unverified, even if the primary-payment demo passes.

Suggested rehearsal budget: 10 minutes for deployed checks, 20 for the two-wallet flow, 20 for critical UX, 15 for controlled failure/restart checks, and 15 for recording/link verification. These are planning estimates; allow more time for passkey/device issues. Fix safety blockers before recording; label remaining limitations explicitly.

```sh
# Node 22+; GET requests only. No credentials are needed.
node --test scripts/check-judge-readiness.test.mjs
node scripts/check-judge-readiness.mjs https://wallet.cherrymoney.co.uk --require-payments > judge-smoke.json
```

Omit `--require-payments` when checking a deliberately disabled bootstrap environment. The checker tests JSON/content types, readiness, runtime consistency, unsupported funding gates, API paths, typed invoice errors, SPA shells and JS availability. It does not render routes or verify the deployed source revision. A 200 SPA shell alone never proves that a route's UI works.

## Live payment and reconciliation

| ID | Steps | Expected result / evidence |
| --- | --- | --- |
| P1 | Merchant creates an invoice with reference, 0.1 XLM and future expiry. Scan its QR on a separate device. | QR contains the saved `/pay/<id>` URL. Checkout shows the same merchant, destination, amount and expiry before sign-in. Capture both views. |
| P2 | Payer signs in/enrols with a physical passkey and returns to the invoice. | Same invoice context; verified Testnet wallet/signing availability. Login alone does not submit payment. Record device and deployment transaction evidence. |
| P3 | Preview the invoice payment; inspect recipient, XLM amount, Testnet and sponsored fee. Try approval before ticking acknowledgement, then approve once. | Approval disabled before acknowledgement. Exact invoice ID/amount preserved. One persisted attempt and one explicit payment authorization. |
| P4 | Observe submission and confirmation. Open receipt only after verification. | Pending/unknown is not success. Verify committed network, SAC, from/to, exact amount, ledger and event identity against trusted chain data; receipt hash matches explorer. |
| P5 | Refresh merchant invoice, balance and history. | One verified receipt allocated to this invoice, correct remaining/paid amounts and event key `TESTNET:<hash>:<operationIndex>:<eventIndex>`. No equal-amount heuristic. Allow asynchronous indexing; record delay rather than editing totals. |
| P6 | Reload both sessions and reopen paid checkout. | Receipt and totals persist; no fresh preview for a paid invoice. History/detail/explorer agree. Check database attempt/allocation counts if diagnosing a duplicate. |

**Record:** invoice ID/reference, payer and merchant public addresses, attempt ID, transaction hash, asset contract, ledger, operation/event indexes, event ID, amount, before/after invoice totals, CI URLs, deployed revision and recording timestamps. Public addresses are public data; obtain consent before associating them with a person's identity.

## Failure, security and persistence coverage

Run destructive/fault-injection cases in isolated local/staging infrastructure, not against an in-use demo database. Relevant automated tests exist in `apps/api/src/payments`, `smart-account`, `invoices` and `apps/web/src/payments`/`invoices`.

| ID | Case | Required behaviour |
| --- | --- | --- |
| F1 | Invalid checksum, unsupported G/C route, muxed address, memo-required destination or wrong network | Clear actionable rejection; no approval or send. Only advertise the server's supported receive route. |
| F2 | Zero, negative, exponent/comma input, more than seven decimals, insufficient balance including fee | Reject exact invalid input without rounding; explain how to correct it; no signing call. |
| F3 | Change signer policy after preview; tamper with recipient, amount, invoice ID or authorization payload | Reject before submission; stale preview requires fresh verified authorization. Session/email possession is insufficient. |
| F4 | Cancel the passkey prompt; let a quote expire; interrupt before signing | Explain state and allow safe review/cancellation of the same unsigned attempt. Do not imply payment succeeded. |
| F5 | Disconnect after authorization/submission; double-click; reload; reopen another tab | Durable key resolves to the same attempt. Unknown outcome remains unresolved until verified. No replacement or second signing/submission from status checks. |
| F6 | RPC timeout/error, indexer ingestion failure, app restart and temporary database outage | Fail closed; preserve last durable status/cursor. Readiness fails when DB is unavailable; liveness remains separate. Resume from persisted cursor; never skip a retention gap. |
| F7 | Reingest the same event; use two invoices with the same amount; inspect external unmatched receipt | Exactly one event/allocation. No automatic match by amount; manual allocation needs explicit evidence and owner authorization. |
| F8 | Another user's invoice/admin/attempt requests; untrusted Origin; expired session | Enforce ownership, origin and authentication without leaking private data. Public invoice terms are intentionally public; merchant management is private. |
| F9 | Paid, expired or stale/unavailable checkout; response has a different invoice ID or forged totals | No fresh payment; honest reload/status action; reject inconsistent response. |
| F10 | Lose access to primary device; attempt independent backup recovery | Only claim recovery after a real, separate-device on-chain policy/spend exercise succeeds. A second login credential or mocked recovery test is insufficient. Mark BLOCKED/NOT_RUN otherwise. |

Existing CI covers many failure paths with fixtures; the live F5/F6 rehearsal is separate acceptance work. Use a staging proxy or test harness to inject transport faults, not production configuration edits.

## UX prize evidence matrix

Prepare one coherent evidence pack for both reported UX prizes; check their exact rules before entry. This is our acceptance standard, not an invented organiser rubric or a certification claim.

| ID | Device / method | Task and pass condition | Evidence |
| --- | --- | --- | --- |
| U1 | First-time merchant/payer, no coaching | Explain the merchant, amount, Testnet and purpose before approval; distinguish pending from paid afterwards | Observations, task completion, elapsed time and confusion notes; target three participants |
| U2 | 320 CSS-pixel viewport; 390px phone; tablet; desktop | Onboarding, QR checkout, review, errors and receipt have no clipped primary controls or page-wide overflow; long addresses wrap; QR scans from another device | Screenshots per breakpoint plus real iOS/Android passkey/QR run |
| U3 | Keyboard only, Tab/Shift+Tab/Enter/Space | Reach all controls in logical order; visible focus; review and status receive focus; edit returns to recipient; error is focused; no trap or accidental approval | Continuous keyboard recording; automated review/edit/error regression tests |
| U4 | VoiceOver/Safari or NVDA/Firefox | Merchant/amount/network/fee and field labels are announced; pending/error/verified state changes are understandable; receipt link has a useful name | Tester/device/version and short recording; automated DOM roles are not sufficient |
| U5 | 200% zoom; 400%/320px reflow; contrast inspection | Content and primary actions remain operable; normal text at least 4.5:1, large text/UI indicators at least 3:1 where applicable; no colour-only status | Measured samples and screenshots; investigate focus ring visibility and disabled-state clarity |
| U6 | Real touch device | Primary controls comfortably tappable (target 44×44 CSS px); no overlapping actions; exact amount input works without rounding | Screen recording including portrait and landscape |
| U7 | Slow/offline transport, interrupted approval, denied clipboard | Specific next action, retained invoice/attempt, no lost typed data where safe; copy fallback readable; status retry never resends | Failure clip and matching attempt record |
| U8 | Reduced motion enabled | No essential animated-only information or disruptive motion; loading/confirmation still clear | OS/browser setting and recording |
| U9 | Signed-out browser and submitted URLs | Landing page explains Testnet/product value; invoice terms readable before auth; developer/deck/video/repo links accessible; no false live claims for unavailable integrations | Link checklist and signed-out screenshots |

Focus on a short, understandable core journey rather than adding unrelated integrations. Suggested UX demo: scan invoice → review plain-language terms → passkey approve → see verified receipt; then one interrupted-payment recovery. Capture usability results honestly, including failures and help needed.

## Result log template

Copy a row per case; keep test data separate from production and keep unpublished recordings private until consented.

| Case | Result | UTC time | Commit / deployed revision | Tester / browser / device | Evidence URL | Defect / follow-up |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | NOT_RUN | — | — | — | — | Record CI and local outputs |
| P1–P6 | NOT_RUN | — | — | — | — | Physical passkeys and live receipt required |
| U1–U9 | NOT_RUN | — | — | — | — | Split into individual cases when executed |
| F10 | NOT_RUN | — | — | — | — | Do not claim independent recovery |

The template intentionally starts unexecuted. Attach actual evidence rather than changing a row based on a feature's presence in code.
