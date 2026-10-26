# Cherry Pay wallet experience

The Home screen uses the existing verified Testnet balance and receipt APIs, with an asset tile, Send/Receive actions, an optional XLM market reference, and a dismissible upgrade banner. Header menus provide Cherry Money, Cherry Tax, support, security and activity exports. Payroll has a dedicated desktop sidebar entry and a mobile Products entry. The favicon is a local SVG.

## Upgrade preview

`/upgrade` presents Essential (the current free Testnet release) and proposed Plus/Business plans. No subscription, checkout, entitlement, cashback or price is implemented. Existing business tools remain free. Paid activation needs separately agreed pricing, billing and server-authorized entitlements. Test tokens cannot buy a plan.

## Access history

Migration `016_access_history.sql` records new successful passkey sessions atomically with session creation. Older sessions are not backfilled. The owner-only page shows the latest 100 events within 30 days, with browser-reported device details, observed IP, timestamps and active-session revocation. Raw tokens and their hashes never enter responses. Logout removes session authority while preserving the audit event until retention cleanup. Cleanup runs on service startup and hourly; failures retry without blocking authentication. Backups follow the operator’s separate retention policy.

- `GET /api/v1/session/access-history`: bearer-authenticated, no-store; returns `items`, `truncated`, `mapsBrowserKey` (public restricted browser key or null). Each item has `id`, `createdAt`, `expiresAt`, `ip`, `userAgent`, `current`, `active`, and `location` (null or latitude/longitude/source).
- `POST /api/v1/session/access-history/:id/revoke`: requires an active bearer session and the configured Origin; deletes only an owned session, returns 204 or 404 when unavailable. Revoking the current session immediately invalidates subsequent requests.
- `POST /api/v1/session/location`: same authentication/Origin requirements; body `{latitude:number, longitude:number}`. Records only the current session’s voluntarily shared browser coordinates, rounded to one decimal place. Location is self-reported, approximate, and never authorization evidence.

The browser never requests location automatically. A second action loads the Google map with an explanation of the Google request. An API key does not locate IP addresses. No external IP geolocation service is called. Device strings and IPs are informational and may describe proxies or be spoofed; they are not proof of a device or location.

Configure `GOOGLE_MAPS_BROWSER_KEY` on the API service with a **browser key** restricted to `https://wallet.cherrymoney.co.uk/*` and the Maps Embed API. The key is intentionally public when served to the authenticated UI. Verify that Maps Embed API is enabled; an existing key restricted to other APIs will not work. Never put an IP-restricted server key here. Existing HabitMove keys and their restrictions were not changed. The map remains optional when no key is configured.

## Market reference

`GET /api/v1/market/xlm?days=1` supports 1, 7, 30, 90 and 365 days. Configure `COINGECKO_DEMO_API_KEY` on the API service to enable CoinGecko XLM/USD data. Requests use the server-only authentication header, an eight-second timeout, per-period request coalescing, a five-minute cache and a one-minute failure backoff. Responses validate positive ordered prices and a last observation within two hours. Provider failures or missing configuration return 503 without exposing provider errors or credentials. No fiat valuation is assigned to Testnet tokens and market data is never used for payment approval.

Both optional variables must be forwarded into the API container by the deployment environment; see `compose.yaml`. Do not commit real values. No native download or real-crypto on/off-ramp is advertised as available.

## Release and rollback

Deploy the additive migration before serving the new API. Existing payment, funding and signer policies remain unchanged. A rollback can restore the previous web/API image while retaining the additive table; do not drop audit data as part of an application rollback. Update the service privacy notice to describe access history and optional location retention before release.

Validation includes the normal web build/lint/tests, API typecheck/tests, and PostgreSQL migration/ownership/revocation checks in CI. Browser previews use explicitly labeled sample data; they are not live Testnet settlement evidence.
