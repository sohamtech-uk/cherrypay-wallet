# Azure Testnet deployment handoff

Infrastructure verified on 25 October 2026. This is a Testnet preview; payments remain disabled.

## Running infrastructure

- Wallet: https://wallet.cherrymoney.co.uk/
- Generated Azure hostname: https://ca-cpw-wallet-testnet-uks.proudhill-de1f30f8.uksouth.azurecontainerapps.io/
- Resource group: `rg-cpw-wallet-testnet-uks`, UK South.
- Container App: `ca-cpw-wallet-testnet-uks`; API and frontend share the same HTTPS ingress.
- PostgreSQL: `pg-cpw-wallet-tn-cm65062`, PostgreSQL 17, B1ms, 32 GiB, seven-day backups, public access disabled.
- The app uses a restricted database role and a Key Vault connection reference. The temporary administrator initialization job completed successfully and was removed.

Live checks passed for `/health`, `/ready`, `/api/v1/network`, and the `/history` SPA route. HTTP redirects to HTTPS. Unsupported origins receive HTTP 403; payment routes return HTTP 503 while the integration is disabled.

The WebAuthn origin and RP ID are configured for `wallet.cherrymoney.co.uk`. DNS and TLS are now ready on that domain. Real browser passkey registration/sign-in acceptance remains outstanding; the generated Azure hostname is for preview and health checks.

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

## DNS and managed HTTPS

These records were added at GoDaddy in the `cherrymoney.co.uk` DNS zone on 25 October 2026, with a one-hour TTL. Both resolve publicly:

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `wallet` | `ca-cpw-wallet-testnet-uks.proudhill-de1f30f8.uksouth.azurecontainerapps.io` |
| TXT | `asuid.wallet` | `F8473B026A0197104EFF24406E6DF5FEDCFE4AB80F5C405878EE8EA973D7D948` |

Existing mail, apex and other application records were preserved. Keep the CNAME pointed directly at the Container App and retain the verification TXT record.

The hostname was added to the wallet app. The certificate command uses the shared environment's full resource ID because its resource group differs from the app's:

```bash
az containerapp hostname add \
  -g rg-cpw-wallet-testnet-uks -n ca-cpw-wallet-testnet-uks \
  --hostname wallet.cherrymoney.co.uk
az containerapp hostname bind \
  -g rg-cpw-wallet-testnet-uks -n ca-cpw-wallet-testnet-uks \
  --hostname wallet.cherrymoney.co.uk \
  --environment /subscriptions/5e8bcb62-85d3-4ca9-bc9d-8694bbe65062/resourceGroups/rg-cm-nonprod-uks/providers/Microsoft.App/managedEnvironments/cae-cm-nonprod-uks \
  --validation-method CNAME
curl --fail https://wallet.cherrymoney.co.uk/ready
```

Verified on 25 October 2026 at 21:21 UTC:

- Managed certificate `mc-cae-cm-nonprod-wallet-cherrymon-7260` in `cae-cm-nonprod-uks`: provisioning `Succeeded`, validation `CNAME`, subject `wallet.cherrymoney.co.uk`.
- App custom-domain binding: `SniEnabled`, referencing that managed certificate.
- A TLS handshake with standard certificate and hostname verification succeeded using TLS 1.3. The certificate SAN is `wallet.cherrymoney.co.uk`, issued by DigiCert's `GeoTrust TLS RSA CA G1`, valid through 25 April 2027. Azure manages renewal; retain the direct CNAME and issuance prerequisites.
- `http://wallet.cherrymoney.co.uk/ready` returns HTTP 301 to the HTTPS URL.
- HTTPS `/health`, `/ready`, `/api/v1/network`, `/api/v1/smart-account/capabilities`, and `/history` return HTTP 200. Readiness reports `TESTNET`; deployment, spending and recovery remain disabled.
- The Cherry Wallet overview loads in a browser at the custom hostname without a certificate warning. This does not constitute passkey enrollment or payment acceptance.

See [Azure hostname CLI](https://learn.microsoft.com/en-us/cli/azure/containerapp/hostname) and [deployment runbook](AZURE_DEPLOYMENT.md).

## Remaining acceptance

1. Real browser passkey enrollment/sign-in on the final hostname.
2. Reviewed smart-account deployment, independent backup signer and recovery proof (B1/B2).
3. A real passkey-authorized Testnet XLM payment, exact confirmed event, balance/history/receipt, and timeout/restart reconciliation.
4. Database restore drill and operational retention/monitoring acceptance.

Keep payments disabled until the on-chain acceptance evidence passes. Infrastructure readiness does not establish wallet deployment, recovery or spending readiness.
