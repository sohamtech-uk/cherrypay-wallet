# Genesis — Stellar Composed: judge guide

**Pitch:** Cherry Pay turns a merchant invoice into a passkey-approved Stellar payment and a receipt the merchant can reconcile. The initial user is a small business or community organisation that needs to request and identify payments without making every customer learn wallet addresses, seed phrases and network fees.

This is a problem hypothesis informed by the team's Cherry Money domain experience, not a claim of completed customer research or traction. The new product is the Stellar wallet/invoice MVP. Existing Cherry Money branding, business experience and reusable code are disclosed below.

[Live Testnet app](https://wallet.cherrymoney.co.uk) · [develop source](https://github.com/sohamtech-uk/cherrypay-wallet/tree/develop) · [test plan](JUDGE_TEST_PLAN.md) · [dated validation record](JUDGE_VALIDATION_2026-10-26.md).

## What is composed

| Component | Role in the user journey | Implementation evidence |
| --- | --- | --- |
| Smart Account Kit generated bindings + OpenZeppelin account/WebAuthn verifier | Passkey-controlled contract account; a login session alone cannot authorize payment | [Pinned v0.8.0 preflight](../apps/api/src/smart-account/kit-v080-preflight.ts), [primary payment adapter](../apps/api/src/smart-account/primary-payments.ts), [API dependencies](../apps/api/package.json) |
| Stellar SDK + native XLM SAC + Stellar RPC | Simulate and construct the exact transfer, sponsor fees, verify committed transfer data | [Payment implementation](../apps/api/src/payments/), [smart-account adapters](../apps/api/src/smart-account/) |
| Cherry Pay application | Invoice QR/link, amount review, durable attempt recovery, event-based receipt allocation | [Invoice API](../apps/api/src/invoices/), [checkout UI](../apps/web/src/invoices/), [payment UI](../apps/web/src/payments/) |

The account stack and SDK/payment stack cooperate in one workflow. The account/verifier and their bindings are closely related; do not present them as multiple unrelated integrations. The relayer is our controlled integration, not a claim that the OpenZeppelin Relayer service is deployed. We use generated kit bindings, not the full Smart Account Kit helper package. PostgreSQL is application infrastructure, not an extra Stellar ecosystem integration.

Our composition claim is the usable invoice-to-receipt workflow these components enable. Demonstrate it running; a dependency list is insufficient. [Official track guidance](https://www.hackmeridian.com/build) describes composing ecosystem tools into a useful new product. Organisers determine eligibility, including treatment of reused work.

## Judging criteria and remaining evidence

Weights below follow the event slides and [published rubric](https://www.hackmeridian.com/build). These are evidence targets, not a predicted judge score.

| Criterion | Weight | What to show | Remaining gap |
| --- | --- | --- | --- |
| Track alignment | 20% | Passkey smart account + SDK/SAC transfer + invoice reconciliation, with source links above | Record the integrated Testnet flow and contract/transaction evidence |
| User value and problem | 20% | Merchant shares one invoice link; payer approves clear terms; merchant sees the corresponding receipt | Observe three prospective users and record confusion, task success and quotes with consent |
| Technical execution | 15% | Exact amounts, signer boundaries, persisted attempts, verified receipt and passing database/container CI | Capture a live receipt and controlled uncertain-outcome recovery |
| Innovation | 15% | Business payment intent remains attached through passkey authorization, uncertain submission and reconciliation | Demonstrate why the invoice link and reconciliation improve on copying an address into a generic wallet; avoid claiming novel cryptography |
| Hackathon progress | 10% | Dated commits/PRs below and before/after story | Freeze the submitted commit and list any subsequent changes separately |
| Market and ecosystem potential | 10% | Small-business/community-organisation pilot, reusable payment APIs and a practical adoption test | Validate demand and willingness to pay; no revenue, partner or customer numbers claimed |
| Product design and UX | 10% | QR checkout, no seed-phrase step, sponsored fees, readable confirmation, keyboard flow and honest recovery | Complete device/accessibility/usability evidence in the UX matrix |

The team reports **two additional UX prizes**. Prepare the UX evidence pack for both; prize names, eligibility and any separate submission fields must be checked against the organiser's prize brief. Their detailed rubrics have not been verified here. Do not assume the main rubric's 10% UX weight is their separate scoring rule.

## Demo script (target: approximately three minutes)

1. **0:00–0:25 — problem and user.** “A small business needs to request a payment and know which invoice it settles. Copying wallet addresses and comparing amounts leaves work for both sides.” Show the merchant invoice, clearly labelled Testnet XLM.
2. **0:25–0:55 — request.** Create a small Testnet invoice; show its reference, expiry and QR/link. Open that saved link in the payer's separate session/device. Show merchant, exact amount and destination before login.
3. **0:55–1:40 — review and approve.** Use the payer's physical passkey. Show Testnet, recipient, amount, sponsored fee and total. Explicitly approve once. Show pending/unknown honestly if it occurs; status checking must not create another payment.
4. **1:40–2:20 — verify and reconcile.** Wait for verified confirmation. Open the Testnet explorer receipt; show the merchant invoice's allocation, event identity and remaining amount. Keep the invoice reference visible so judges can connect both sides.
5. **2:20–2:45 — explain composition.** Show the source map above and explain account authorization, fee-only sponsorship and event-based reconciliation. A separate pre-recorded controlled failure clip can show recovery without resending.
6. **2:45–3:00 — boundary and next step.** “This is a Testnet prototype. Independent lost-device recovery and customer validation remain acceptance work. Next is a small merchant pilot.”

Do not splice a mocked confirmation into the live-payment recording. If payment verification fails, show the unresolved state and disclose it. Do not expose emails, sessions, API keys or WebAuthn credential payloads in public recordings. Use demo identities and consented participants.

## Weekend progress and prior work

These merged PRs are repository evidence, not proof that every feature was deployed or manually accepted:

| Date (UTC) | New wallet milestone | Source |
| --- | --- | --- |
| 25 October 2026 | Payment backend and PostgreSQL persistence | [#15](https://github.com/sohamtech-uk/cherrypay-wallet/pull/15), [#17](https://github.com/sohamtech-uk/cherrypay-wallet/pull/17) |
| 25 October 2026 | Frontend/payment adapter integration | [#21](https://github.com/sohamtech-uk/cherrypay-wallet/pull/21), [#23](https://github.com/sohamtech-uk/cherrypay-wallet/pull/23) |
| 26 October 2026 | Automatic deployment and funded primary-payment path | [#42](https://github.com/sohamtech-uk/cherrypay-wallet/pull/42), [#52](https://github.com/sohamtech-uk/cherrypay-wallet/pull/52) |
| 26 October 2026 | Invoice QR checkout and reconciliation | [#66](https://github.com/sohamtech-uk/cherrypay-wallet/pull/66) |
| 26 October 2026 | Developer API portal and current OpenAPI route | [#68](https://github.com/sohamtech-uk/cherrypay-wallet/pull/68) |

**Prior work:** Cherry Money business/brand assets and the team's Monad-Metropolis work predate this Stellar MVP. [Reuse review](MONAD_REUSE.md) describes transferable patterns and ecosystem differences. Do not present EVM indexers, signatures or earlier chain integrations as newly built Stellar components. Aurora funding is disabled on this Testnet route; Nansen returns unsupported for Stellar; Envio is not used to index this chain. Optional Wallet Backend integration is not part of the demonstrated core without deployment evidence.

**AI disclosure:** AI assistance was used for implementation, tests, documentation and review. Reused libraries retain their upstream attribution. The team remains responsible for verification, security boundaries and the submitted claims. No independent security audit is claimed.

## Pilot and continuation hypothesis

Recruit three small-business or community-organisation operators for observed Testnet sessions. Each creates an invoice, shares it with a first-time payer, finds the receipt and explains whether the invoice is paid. Record task completion, time, mistakes, requests for help and whether they understand that Testnet XLM has no settlement value. Proposed targets: all participants identify the recipient/amount/network before approval; no participant interprets pending as paid; at least two complete the invoice task without coaching. These are targets, not achieved results.

Ask what they use today, how often reconciliation fails, what an improvement would be worth, and whether they will join a limited pilot. Evaluate a paid business reconciliation/API product only after those interviews. Production stablecoins, anchor cash-out, regulatory requirements and robust account recovery need separate design and validation; no launch date is promised.

## Submission completion

- [ ] Record the live flow on the exact deployed revision and attach receipt/event evidence.
- [ ] Update the existing deck to match invoice functionality and current evidence boundaries.
- [ ] Publish a judge-accessible video/watch link and deck link; test them in a signed-out browser. A private file or local recording is insufficient.
- [ ] Link `develop` and the frozen commit, not a stale default-branch README.
- [ ] Enter Genesis / Stellar Composed, the problem, composition, new weekend work and reuse/AI disclosure in the submission form.
- [ ] Check both UX prize briefs and add any required entries or artifacts.
- [ ] Verify the portal submission receipt before the organiser's deadline (Monday 26 October, 12:00 per event guidance).

The existence of a deck/video file is not evidence that these checklist items are complete. No portal submission is asserted by this guide.
