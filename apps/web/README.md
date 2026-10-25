# Cherry Pay Wallet UI — A1–A3

Testnet-only React/TypeScript frontend scaffold, navigation, onboarding information, wallet overview, security placeholder, and watch-only Testnet classic-account balance lookup.

## Run
```sh
cd apps/web
npm install
npm run dev
npm test
npm run build
```

## Important security / functional limits
- **No wallet creation or passkey registration is implemented yet.** Those actions are deliberately disabled until B1–B2 provide verified backend/contract integrations.
- No signing, spending, production network selection or secret key storage.
- Existing **classic G-address** balances are read from public Stellar Testnet Horizon; **C-address** smart-account balance requires a SAC-compatible adapter and currently shows a clear unsupported message.
- Watch-only address is held in sessionStorage (public address only), never private keys or passkey material.
- Testnet is hardcoded. No Mainnet fallback.
- Address regex is a UI shape check, not full StrKey checksum validation; backend must validate authoritatively.

This implements frontend foundation A1–A3 **partially**; the live passkey wallet creation and smart-account dashboard remain blocked on Contributor B's implementation.
