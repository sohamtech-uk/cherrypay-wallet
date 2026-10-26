# Email, passkey, C-wallet and Testnet allocation

The default UI accepts an email and calls `POST /api/v1/passkeys/onboarding/options`
with `{email}`. The API normalizes the email and selects authentication if a
credential exists, or initial registration otherwise. An interrupted enrollment
reuses the stored WebAuthn user handle. Registration completion locks the account
and refuses a second initial credential. A missing device credential or cancelled
login never falls back to replacing an existing credential.

The browser must ask for the device's passkey confirmation. Email is an account
identifier; this flow does not verify mailbox ownership. Session credentials stay
in memory. Legacy UUID accounts retain their existing sign-in route.

After verified registration or login, the UI queues or resumes the user's
passkey-controlled C-address deployment. It displays an address only after the
worker verifies the committed deployment and current primary signer binding.
There is no user G-wallet or user Stellar secret seed.

Once the C-wallet is verified, the UI offers **Fund Testnet wallet**. The
session-authenticated `POST /api/v1/smart-account/funding` accepts only an empty
object. The server obtains the recipient from that owner's verified deployment.
It queues exactly **100,000 Testnet XLM (1000000000000 stroops)** once per owner
and C-address. Repeated requests return the existing allocation. This is an
allocation receipt, not a claim that the wallet's current balance always remains
100,000 XLM after spending.

## Runtime configuration

Use the existing automatic deployment configuration, plus the server-only
`STELLAR_TESTNET_FAUCET_SECRET` for a dedicated, sufficiently funded Testnet
treasury. It must differ from both the deployment fee source and payment relayer.
The operator configures this once, never per user. No secret enters the browser.
`compose.activation.yaml` passes this optional secret to the API; other deployment
systems must inject it through their secret configuration. Without it, the UI
explains that funding is not configured and disables the button.

Native XLM cannot be minted by this application. Friendbot's normal allocation
is not a 100,000 XLM grant. The operator must provide enough Testnet treasury
liquidity for the users served, plus fees. This implementation does not automate
repeated Friendbot requests to manufacture that amount. Insufficient liquidity
leaves allocations pending; it never substitutes a database balance.

`WALLET_DEPLOYMENT_PILOT_LIMIT` defaults to `0` (no owner-count cap); operators may
set a cap from 1 to 1000. Deployment remains opt-in with
`WALLET_DEPLOYMENTS_ENABLED=true`. Existing fee caps remain enforced. Public
onboarding permits multiple email identifiers; one allocation per wallet is not
one allocation per human, nor proof of mailbox ownership.

## Reconciliation and operation

Migration 011 stores funding requests and exact signed envelopes. PostgreSQL
serializes the treasury source across replicas; a submitted row reserves its
sequence across process restarts. The envelope is committed before broadcasting.
An RPC timeout retries only the same bytes. An expired transaction with unknown
outcome remains submitted for operator investigation; never delete its row or
clear the reservation to issue a replacement without resolving that outcome.
A committed failure is terminal and requires operator review.

Funding is marked complete only after RPC transaction verification proves a
successful native XLM SAC transfer with the exact treasury, C-recipient and
amount. Positive balance, indexer data, or HTTP submission success is insufficient.
No automatic second allocation is issued after login, spending or a restart.
Use this treasury only through this worker; external transactions would interfere
with its source sequence. Rotate its key only after resolving outstanding jobs.

Primary deployment and inbound Testnet funding do not enable spending or certify
independent backup recovery. Existing activation and recovery checks still apply.

## Validation boundary

Unit tests cover email routing, exact transaction construction, fee/network checks,
receipt validation, authenticated funding routes and UI confirmation states.
PostgreSQL integration tests cover duplicate requests, checkpoint-before-broadcast,
restart recovery, worker serialization and uncertain outcomes with synthetic chain
evidence. Real passkey-device and funded live Testnet acceptance must still be run
in the configured deployment; mocked tests do not prove those steps.
