# Dedicated Stellar Testnet relayer

The relayer pays network fees only; it must never own or sign as a customer's smart account.

Generate a **new** secret locally (never paste it into chat or commit it):

```bash
docker compose exec api node -e "const {Keypair}=require('@stellar/stellar-sdk');const k=Keypair.random();console.log('PUBLIC_KEY='+k.publicKey());console.log('SECRET_KEY='+k.secret())"
```

Store the secret in your local environment or secret manager as `STELLAR_RELAYER_SECRET`. Keep the public key for the Stellar Friendbot funding request:

```bash
curl "https://friendbot.stellar.org/?addr=YOUR_PUBLIC_G_ADDRESS"
```

Fund **Testnet only**; verify the G-address using Stellar Testnet Horizon before attempting submissions. Do not use this key for production or user wallet signing.

`GET /api/v1/smart-account/relayer` exposes only public readiness and public key, never the secret. The endpoint does not imply the relayer is funded or that deployment is enabled.

**Outstanding**: SDK deployment payload, signed transaction submission, replay-safe job claims, on-chain contract and signer verification, recovery, and activation. Do not enable `WALLET_PAYMENTS_ENABLED` based on relayer configuration alone.
