# wallet.cherrymoney.co.uk on Azure (Stellar Testnet)

The deployment source is ready for an Azure account connection. No Azure resource, DNS record, or certificate has been created by adding these files. The shared ChatGPT implementation plan was inaccessible; this deployment implements the repository's existing Testnet scope.

## Runtime

`infra/azure/wallet.bicep` creates one dedicated Container App, with a compiled Node API and a static nginx frontend sharing localhost networking. Only nginx port 8080 has public HTTPS ingress. `/api/*` retains the browser's Origin and Authorization headers; nginx never retries a payment request. API port 3001 has no external ingress. The final WebAuthn origin and RP ID are `https://wallet.cherrymoney.co.uk` and `wallet.cherrymoney.co.uk`. Passkeys created for localhost or another hostname do not transfer automatically.

The template uses an existing Container Apps environment, ACR registry, and user-assigned image-pull identity. It does not alter Cherry Money's existing apps or create roles. Provision a dedicated wallet PostgreSQL database and restricted database user on a reachable server before deploying. For Azure PostgreSQL Flexible Server, retain verified TLS and restrict network access to the chosen Container Apps environment; do not enable a blanket public firewall rule. Configure backups and prove a restore before storing anything that cannot be recreated.

`DATABASE_URL` is an Azure secret reference. Use a percent-encoded PostgreSQL URL without `sslmode`, `ssl`, or other SSL query parameters; `DB_SSL=true` explicitly verifies certificates and hostnames using Node's trusted roots. Production refuses plaintext or URL SSL overrides. If a private CA is required, arrange an explicit trusted CA file through `NODE_EXTRA_CA_CERTS`; do not disable verification. Never put a database connection string into Vite variables, a manifest, source control, or command-line arguments.

`/health` is process liveness; `/ready` checks PostgreSQL and returns only a generic status on failure. Migrations finish under the existing database lock before the listener starts. Both containers must pass readiness. There is one minimum and maximum replica so the payment monitor is not scaled to zero. Azure can briefly overlap old/new revisions; the existing PostgreSQL leases and idempotency protections still apply. Payment activation is disabled in this bootstrap template, and the deployment script refuses to overwrite a payment-enabled runtime.

## Configuration and deployment

Configure the `azure-wallet-testnet` GitHub environment with:

| Type | Name | Value |
| --- | --- | --- |
| Variable | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | Dedicated GitHub OIDC deployment identity and selected subscription |
| Variable | `AZURE_RESOURCE_GROUP`, `AZURE_LOCATION` | Wallet app resource group and existing environment's region |
| Variable | `AZURE_CONTAINER_APP` | `cherrypay-wallet-testnet` (or another dedicated wallet app name) |
| Variable | `AZURE_CONTAINER_ENVIRONMENT_ID` | Existing managed environment resource ID |
| Variable | `AZURE_CONTAINER_REGISTRY` | ACR resource name, not its hostname |
| Variable | `AZURE_REGISTRY_IDENTITY_ID` | User-assigned managed identity resource ID with ACR image-pull access |
| Secret | `WALLET_DATABASE_URL` | Dedicated wallet PostgreSQL connection URL |

Scope OIDC federation to `repo:sohamtech-uk/cherrypay-wallet:environment:azure-wallet-testnet`, and restrict that environment's deployment branches to `develop`. Grant only the resource/registry operations needed to build images and deploy this app, plus permission to assign the existing image-pull identity. Do not grant subscription-wide Owner or store an Azure client secret. ACR must permit ARM-audience managed-identity authentication for the image-pull identity.

The `Wallet Azure production images` workflow builds and smoke-tests both production images on pull requests and develop pushes. The deployment job runs only on manual dispatch for `develop`, after its container checks pass. GitHub requires the workflow file on the repository's default branch before exposing `workflow_dispatch`; until that is arranged, an authorized operator can run the same `bash infra/azure/deploy.sh` from a clean, checked-out develop commit in Azure Cloud Shell or an authenticated CLI. Set the configuration above in the environment through your secret manager. The script requires Azure CLI (with Container Apps and Bicep support), Node 24, Git and curl. Do not enable `set -x`.

The script builds API/web images with ACR, resolves their SHA256 digests, sends the database URL as a secure ARM parameter in a temporary mode-0600 file, and deletes the file on exit. It preserves custom-domain certificate bindings on updates and refuses an existing app without the wallet/Testnet tags. Deployment does not become successful until the generated Azure hostname's readiness endpoint confirms Testnet. No live wallet payment or physical passkey ceremony is implied by a successful infrastructure deployment.

## DNS and HTTPS

Read actual values after provisioning:

```bash
az containerapp show -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_CONTAINER_APP" \
  --query '{hostname:properties.configuration.ingress.fqdn,verification:properties.customDomainVerificationId}'
```

At the authoritative DNS provider for `cherrymoney.co.uk`, create only these records, checking for conflicting existing records first:

| Record | Name | Value |
| --- | --- | --- |
| CNAME | `wallet` | Actual generated Container App hostname from the command above |
| TXT | `asuid.wallet` | Actual domain verification value from the command above |

The CNAME must point directly at the Container App, without a DNS proxy or intermediate CNAME. If the parent domain has CAA restrictions, authorize `digicert.com`. Keep the app running for managed certificate issuance and renewals. Do not replace apex, mail, or other application records.

Once public DNS resolves, bind a managed certificate:

```bash
az containerapp hostname add -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_CONTAINER_APP" \
  --hostname wallet.cherrymoney.co.uk
az containerapp hostname bind -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_CONTAINER_APP" \
  --hostname wallet.cherrymoney.co.uk --validation-method CNAME
curl --fail https://wallet.cherrymoney.co.uk/ready
```

Verify the hostname is secured in Azure, HTTP redirects to HTTPS, `/api/v1/network` says TESTNET, and passkey enrollment/sign-in work on the final hostname. Verify independent client addresses do not share a single rate-limit bucket. The nginx real-IP configuration relies on Azure ingress appending its verified client IP at the right of `X-Forwarded-For`; do not expose this nginx listener directly through an arbitrary proxy or add public TCP ingress.

## Verification and recovery

`bash scripts/test-production-containers.sh` runs the compiled API against real PostgreSQL and nginx in the same network layout. It checks migrations/startup, SPA deep links, API routing, Origin rejection, disabled payments, independent IP rate limiting, and database-down readiness without killing the API. Unit tests cover database TLS downgrade attempts and readiness recovery. The smoke database is disposable and isolated; real deployments always use verified TLS.

For deployment failures, retain the previous healthy revision, inspect only redacted API diagnostic codes, and fix the failing dependency before retrying. Record the previous revision and image digests before a release. Reactivating an old revision does not undo SQL migrations or Azure app-level secret changes: this is not a database rollback strategy. Never drop tables or restore over the live database to resolve a failed container rollout.

After hosting is verified, follow `TESTNET_STARTUP.md` for approved smart-account/recovery evidence and a separate payment-enabled release. This bootstrap cannot enable transfers merely by setting a GitHub variable. The outstanding acceptance run remains a genuine passkey-authorized Testnet transfer with a committed receipt, balance/history updates, and timeout/restart reconciliation.

References: [Azure custom domains and managed certificates](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-managed-certificates), [Container Apps ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview), [hostname CLI](https://learn.microsoft.com/en-us/cli/azure/containerapp/hostname), [Container Apps template schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/2025-01-01/containerapps).
