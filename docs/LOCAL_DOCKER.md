# Cherry Pay Wallet — local Docker development

Prerequisite: Docker with Compose v2.

From the repository root:

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f
```

- Web UI: http://localhost:5173
- API health: http://localhost:3001/health
- API network: http://localhost:3001/api/v1/network

Stop with `docker compose down`. Rebuild with `docker compose up --build -d`.
Run checks using `docker compose exec web npm test`, `docker compose exec web npm run build`, `docker compose exec api npm test`, and `docker compose exec api npm run typecheck`.

This configuration binds published ports to localhost and is for development only. All Stellar endpoints are hardcoded to Testnet. WebAuthn uses RP ID `localhost` and browser origin `http://localhost:5173`. Open the UI via **localhost**, not 127.0.0.1, so passkey origin checks match.

**Limitations:** The API stores passkeys and challenges in memory (lost on restart), has no authenticated wallet ownership or persistent storage, and does not deploy wallets or sign payments. Do not expose these containers publicly or fund wallets based on this prototype. The UI payment adapter is not yet connected to a real payment backend.
