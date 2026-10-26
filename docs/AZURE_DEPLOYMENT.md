# wallet.cherrymoney.co.uk on Azure (Stellar Testnet)

The deployment source includes a private PostgreSQL provisioning path. Adding these files alone creates no Azure resources, DNS records or certificates. The shared ChatGPT implementation plan was inaccessible; this deployment implements the repository's existing Testnet scope.

## Provision a dedicated database and wallet app

`python infra/azure/bootstrap.py --config /path/outside/checkout/wallet-target.json` performs a read-only preflight. Add `--apply` to provision from that exact clean commit. The JSON configuration contains only these non-secret fields:

```json
{
  "subscriptionId": "selected-subscription-id",
  "resourceGroup": "dedicated-wallet-resource-group",
  "location": "uksouth",
  "environmentId": "/subscriptions/.../resourceGroups/.../providers/Microsoft.App/managedEnvironments/...",
  "registryId": "/subscriptions/.../resourceGroups/.../providers/Microsoft.ContainerRegistry/registries/...",
  "vnetId": "/subscriptions/.../resourceGroups/.../providers/Microsoft.Network/virtualNetworks/...",
  "appsSubnetPrefix": "actual-existing-container-apps-subnet-prefix",
  "postgresSubnetPrefix": "verified-unused-private-subnet-prefix",
  "serverName": "globally-unique-wallet-postgresql-name",
  "vaultName": "globally-unique-wallet-vault-name",
  "appName": "dedicated-wallet-container-app-name"
}
```

Preflight checks the selected subscription, resource types, region, existing subnet ranges and environment membership. It refuses overlapping subnets, a mismatched existing wallet subnet, unrelated resource groups and unrelated network security groups. The script does not switch Azure user, tenant or subscription. Keep the config outside the checkout; a dirty checkout is rejected.

The apply path creates a dedicated wallet resource group, Key Vault, a B1ms PostgreSQL 17 server with 32 GiB storage, private DNS and a delegated subnet. Backups retain seven days and storage can grow automatically; this is a small Testnet configuration without high availability. It incurs Azure charges. The database has no public access. A new subnet NSG permits PostgreSQL connections from the existing Container Apps subnet and the PostgreSQL subnet, and denies other clients on port 5432. Existing subnets and existing application databases are not rewritten.

Administrator and runtime passwords are generated inside the provisioning process and persisted in the wallet vault before database creation begins. Retries reuse the stored values. Neither password is shown in chat, logs, command arguments or GitHub secrets. Temporary ARM parameter files are mode 0600 and removed after each operation. The operator receives Secrets Officer on this new vault; the app identity receives Secrets User on the single `wallet-database-url` secret. Separate runtime/bootstrap identities receive AcrPull on the selected registry and no access to Cherry Money's other vaults.

An operator-only Container Apps job connects through the private network to create `wallet_runtime`, grant connection and schema-create permissions, and verify the runtime credentials. The role cannot create roles/databases or bypass row policies. Existing privileged roles are rejected and an existing password is never silently rotated. This initialization job is deleted after success; its database administrator secret is never passed to the web/API app. If initialization fails, its definition remains for diagnosis and retry; delete that temporary job once fixed. Runtime and administrator passwords remain recoverable in the wallet vault.

The script then builds API/web images in ACR, pins both digests, deploys the app with the Key Vault reference, and waits for Testnet readiness. It prints the actual generated hostname and domain verification ID for the DNS steps below. It does not alter DNS automatically or enable payments.

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
| Variable | `WALLET_DATABASE_SECRET_URL` | Preferred: wallet Key Vault secret URL created by bootstrap |
| Secret | `WALLET_DATABASE_URL` | Alternative connection URL when not using Key Vault; configure only one source |
| Secret | `AURORA_INTENTS_API_KEY` | Optional Studio Swap API key, API container only; preserve the same key on later releases |

Scope OIDC federation to the **exact immutable subject** `repo:sohamtech-uk@274770785/cherrypay-wallet@1433143174:environment:azure-wallet-testnet` (not the older name-only subject), and restrict the `azure-wallet-testnet` GitHub environment's deployment branches to **`main`** (not `develop`). Grant only the resource/registry operations needed to build images and deploy this app, plus permission to assign the existing image-pull identity. Do not grant subscription-wide Owner or store an Azure client secret. ACR must permit ARM-audience managed-identity authentication for the image-pull identity.

The `Wallet Azure production images` workflow validates and smoke-tests production images on pull requests and on pushes to `develop` or `main`. **It automatically deploys to the `azure-wallet-testnet` environment after successful container checks only for pushes to `main`** that match the workflow's path filter (`apps/**`, `infra/azure/**`, `scripts/test-production-containers.sh`, `scripts/check-judge-readiness*.mjs`, or `.github/workflows/wallet-azure.yml`). An authorized operator can also use **Run workflow → Branch: `main`**, which runs the same checks before deployment. PR events, pushes to `develop` and manual dispatch from `develop` never deploy. A docs-only merge that does not match the path filter does not deploy automatically; select manual dispatch on `main` if a new rollout is required. Set the environment variables and secrets above before release. The script requires Azure CLI (with Container Apps and Bicep support), Node 24, Git and curl. Do not enable `set -x`.

Before promoting this change, update **Settings → Environments → azure-wallet-testnet → Deployment branches and tags** to allow `main` and review any required reviewers. A workflow cannot override an environment's branch rules, so leaving a `develop`-only restriction will block a `main` deployment even with the fixed workflow. The OIDC trust subject includes GitHub's immutable organization and repository IDs; see the exact values and recovery instructions below. The deployment uses the bootstrap template with payments disabled; **it refuses to overwrite a runtime with primary-passkey payments, recovery-backed payments or Aurora activated**. Preserve that safety boundary and use the separately reviewed payment-enabled release process for an activated wallet.

The script builds API/web images with ACR, resolves their SHA256 digests, sends the database URL as a secure ARM parameter in a temporary mode-0600 file, and deletes the file on exit. It preserves custom-domain certificate bindings on updates and refuses an existing app without the wallet/Testnet tags. Deployment does not become successful until the generated Azure hostname's readiness endpoint confirms Testnet. No live wallet payment or physical passkey ceremony is implied by a successful infrastructure deployment.

The optional Aurora key is also a secure ARM parameter and a Container Apps secret, referenced only by the API container. The template fixes `AURORA_INTENTS_NETWORK=TESTNET` and `AURORA_INTENTS_ENABLED=false`: the current provider route uses mainnet and cannot fund this wallet. A key enables read-only recovery of existing mainnet swaps only. The deployment script refuses to remove an existing Aurora key or overwrite an activated Aurora runtime. Supply the same key through the secret manager on every release after configuration; never put it in source or command arguments.

## GitHub Actions OIDC federation for the main release

GitHub repositories created after July 15, 2026 use immutable organization/repository IDs in the OIDC `sub` claim. Confirmed repository IDs: owner `274770785`, repository `1433143174`. A `deploy` job referencing `environment: azure-wallet-testnet` sends the environment-scoped subject, **not** a `refs/heads/main` branch subject. The Azure federated credential must match these exact values, including case and the two `@ID` segments:

| Claim | Required value |
| --- | --- |
| Issuer (`iss`) | `https://token.actions.githubusercontent.com` |
| Subject (`sub`) | `repo:sohamtech-uk@274770785/cherrypay-wallet@1433143174:environment:azure-wallet-testnet` |
| Audience (`aud`) | `api://AzureADTokenExchange` |

**AADSTS700213** means Entra ID could not find a credential matching the presented subject. The older `repo:sohamtech-uk/cherrypay-wallet:environment:azure-wallet-testnet` subject does not match this repo. The GitHub environment's branch restriction remains `main`. No change to the GitHub `azure/login` issuer or audience is required.

Determine whether the `AZURE_CLIENT_ID` GitHub environment variable belongs to an **App registration** or a **user-assigned managed identity**. Create the credential on that exact identity, not on the image-pull managed identity unless it is also the configured deploy login identity. Do not create a new Azure identity or grant broader access as a workaround.

For an App registration (Azure Cloud Shell Bash), inspect current credentials and add the explicit GitHub trust without using a client secret:

```bash
# Existing Application (client) ID matching GitHub's AZURE_CLIENT_ID variable
APP_CLIENT_ID="<existing-client-id>"
az ad app federated-credential list --id "$APP_CLIENT_ID" \
  --query "[].{name:name,issuer:issuer,subject:subject,audiences:audiences}" -o json

cat > /tmp/cherrypay-github-oidc.json <<'JSON'
{
  "name": "github-cherrypay-wallet-testnet-immutable",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:sohamtech-uk@274770785/cherrypay-wallet@1433143174:environment:azure-wallet-testnet",
  "audiences": ["api://AzureADTokenExchange"],
  "description": "GitHub Actions main -> azure-wallet-testnet"
}
JSON
az ad app federated-credential create \
  --id "$APP_CLIENT_ID" --parameters /tmp/cherrypay-github-oidc.json
rm -f /tmp/cherrypay-github-oidc.json
```

If the `AZURE_CLIENT_ID` instead belongs to a user-assigned managed identity, use the identity's **Federated credentials** configuration in Azure Portal or the corresponding `az identity federated-credential create` command. Do not apply the App-registration CLI example to a managed identity.

After creating the trust, wait for Entra propagation, then **re-run the failed GitHub Actions deploy job** on a `main` run. If OIDC authentication succeeds but deployment still fails, check the next job step for Azure RBAC, missing environment variables/secrets, or the existing bootstrap script's deliberate rejection of an activated payment runtime. No AADSTS700213 fix requires changing repository code, disabling OIDC or storing an Azure client secret.

References: [GitHub immutable OIDC subjects](https://docs.github.com/en/actions/reference/security/oidc), [Microsoft Entra federated credential creation](https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-create-trust).

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
  --hostname wallet.cherrymoney.co.uk \
  --environment "$AZURE_CONTAINER_ENVIRONMENT_ID" --validation-method CNAME
curl --fail https://wallet.cherrymoney.co.uk/ready
```

Pass the full environment resource ID, including its resource group: the shared environment may be in a different resource group from the wallet app. Certificate issuance can take up to 20 minutes. Keep the command running until issuance and binding finish, then verify the live hostname.

Verify the hostname is secured in Azure, HTTP redirects to HTTPS, `/api/v1/network` says TESTNET, and passkey enrollment/sign-in work on the final hostname. Verify independent client addresses do not share a single rate-limit bucket. The nginx real-IP configuration relies on Azure ingress appending its verified client IP at the right of `X-Forwarded-For`; do not expose this nginx listener directly through an arbitrary proxy or add public TCP ingress.

## Verification and recovery

Email identity upgrades use the additive `004_email_identity.sql` migration.
Migrations 001–003 retain the original deployed checksums. The upgrade converts
UUID ownership columns to text without changing existing IDs, passkey user handles,
sessions, payment attempts or approval ownership. The current consumer UI accepts email account IDs; backend compatibility for
original UUID identities is separate from this email-first experience. Newly
created profiles use email IDs.
Never clear the database or rewrite stored checksums to resolve a migration error.
The PostgreSQL upgrade regression test seeds the previous schema and checks restart,
ownership constraints and pending-payment preservation before deployment.

`bash scripts/test-production-containers.sh` runs the compiled API against real PostgreSQL and nginx in the same network layout. It checks migrations/startup, SPA deep links, API routing, Origin rejection, disabled payments, independent IP rate limiting, and database-down readiness without killing the API. Unit tests cover database TLS downgrade attempts and readiness recovery. The smoke database is disposable and isolated; real deployments always use verified TLS.

For deployment failures, retain the previous healthy revision, inspect only redacted API diagnostic codes, and fix the failing dependency before retrying. Record the previous revision and image digests before a release. Reactivating an old revision does not undo SQL migrations or Azure app-level secret changes: this is not a database rollback strategy. Never drop tables or restore over the live database to resolve a failed container rollout.

After hosting is verified, follow `TESTNET_STARTUP.md` for approved smart-account/recovery evidence and a separate payment-enabled release. This bootstrap cannot enable transfers merely by setting a GitHub variable. The outstanding acceptance run remains a genuine passkey-authorized Testnet transfer with a committed receipt, balance/history updates, and timeout/restart reconciliation.

References: [Azure custom domains and managed certificates](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-managed-certificates), [Container Apps ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview), [hostname CLI](https://learn.microsoft.com/en-us/cli/azure/containerapp/hostname), [Container Apps template schema](https://learn.microsoft.com/en-us/azure/templates/microsoft.app/2025-01-01/containerapps).
