# Azure Testnet deployment handoff

Infrastructure verified on 25 October 2026. This is a Testnet preview; payments remain disabled.

## Running infrastructure

- Preview: https://ca-cpw-wallet-testnet-uks.proudhill-de1f30f8.uksouth.azurecontainerapps.io/
- Resource group: `rg-cpw-wallet-testnet-uks`, UK South.
- Container App: `ca-cpw-wallet-testnet-uks`; API and frontend share the same HTTPS ingress.
- PostgreSQL: `pg-cpw-wallet-tn-cm65062`, PostgreSQL 17, B1ms, 32 GiB, seven-day backups, public access disabled.
- The app uses a restricted database role and a Key Vault connection reference. The temporary administrator initialization job completed successfully and was removed.

Live checks passed for `/health`, `/ready`, `/api/v1/network`, and the `/history` SPA route. HTTP redirects to HTTPS. Unsupported origins receive HTTP 403; payment routes return HTTP 503 while the integration is disabled.

The WebAuthn origin and RP ID are configured for `wallet.cherrymoney.co.uk`. The generated Azure hostname is for preview and health checks; passkey registration/sign-in must be accepted on the final domain after DNS and TLS are ready.

## Release evidence

- Deployed application source: `ca50f53689c6dcefb4d5b508413028bb1d50fb19` on `develop`, including the merged onboarding/verifier gates and Cherry Wallet branding.
- Ready revision: `ca-cpw-wallet-testnet-uks--0000001`, observed Healthy and Running.
- Previous revision: `ca-cpw-wallet-testnet-uks--ox3r6qb`. Rollback requires checking retained revision health; it does not reverse database migrations or app-level secret changes.
- API image digest: `sha256:5b5e0acf45b5c37ce2786a130667332f7668b65f123e7b5714cec16cd2f49d7e`.
- Frontend image digest: `sha256:32ca7066e946254e59c582fa795c96966e7c08d5590c8b789ae100aabe150e46`.
- [API CI](https://github.com/sohamtech-uk/cherrypay-wallet/actions/runs/40231011738): 139 tests passed, including real PostgreSQL integration checks.
- [Frontend CI](https://github.com/sohamtech-uk/cherrypay-wallet/actions/runs/40231010798): 55 tests passed, build and lint passed.
- [Production container CI](https://github.com/sohamtech-uk/cherrypay-wallet/actions/runs/40231010827): passed, including Azure templates and bootstrap boundary checks.
- Live `/api/v1/smart-account/capabilities` reports XLM only, pinned v0.8.0 configuration, and deployment/spending/recovery disabled. This endpoint reports configuration, not completed on-chain acceptance.

## DNS to add when access is available

At GoDaddy, in the `cherrymoney.co.uk` DNS zone, add only these records:

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `wallet` | `ca-cpw-wallet-testnet-uks.proudhill-de1f30f8.uksouth.azurecontainerapps.io` |
| TXT | `asuid.wallet` | `F8473B026A0197104EFF24406E6DF5FEDCFE4AB80F5C405878EE8EA973D7D948` |

Neither record resolved during deployment verification. Check again for conflicts before adding them; preserve all existing mail, apex and application records. No CAA record was returned for the parent domain at verification time.

After DNS propagates, run from the intended signed-in Azure subscription:

```bash
az containerapp hostname add \
  -g rg-cpw-wallet-testnet-uks -n ca-cpw-wallet-testnet-uks \
  --hostname wallet.cherrymoney.co.uk
az containerapp hostname bind \
  -g rg-cpw-wallet-testnet-uks -n ca-cpw-wallet-testnet-uks \
  --hostname wallet.cherrymoney.co.uk --validation-method CNAME
curl --fail https://wallet.cherrymoney.co.uk/ready
```

The managed certificate and custom-domain checks have not been completed. See [Azure hostname CLI](https://learn.microsoft.com/en-us/cli/azure/containerapp/hostname) and [deployment runbook](AZURE_DEPLOYMENT.md).

## Remaining acceptance

1. DNS, managed certificate, and real browser passkey enrollment/sign-in on the final hostname.
2. Reviewed smart-account deployment, independent backup signer and recovery proof (B1/B2).
3. A real passkey-authorized Testnet XLM payment, exact confirmed event, balance/history/receipt, and timeout/restart reconciliation.
4. Database restore drill and operational retention/monitoring acceptance.

Keep payments disabled until the on-chain acceptance evidence passes. Infrastructure readiness does not establish wallet deployment, recovery or spending readiness.
