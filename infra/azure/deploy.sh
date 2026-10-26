#!/usr/bin/env bash
set -euo pipefail
# Never enable shell tracing: database URLs and API keys are secrets.
cd "$(dirname "$0")/../.."
for name in AZURE_RESOURCE_GROUP AZURE_LOCATION AZURE_CONTAINER_APP AZURE_CONTAINER_ENVIRONMENT_ID AZURE_REGISTRY_IDENTITY_ID AZURE_CONTAINER_REGISTRY; do
  if [[ -z "${!name:-}" ]]; then printf 'Missing configuration: %s\n' "$name" >&2; exit 1; fi
done
if [[ -z "${WALLET_DATABASE_URL:-}" && -z "${WALLET_DATABASE_SECRET_URL:-}" ]]; then echo 'A database URL or Key Vault secret URL is required' >&2; exit 1; fi
if [[ -n "${WALLET_DATABASE_URL:-}" && -n "${WALLET_DATABASE_SECRET_URL:-}" ]]; then echo 'Configure only one database secret source' >&2; exit 1; fi
command -v az >/dev/null
command -v node >/dev/null
az account show --query id -o tsv >/dev/null
[[ -z "$(git status --porcelain)" ]] || { echo 'Deploy from a clean checkout' >&2; exit 1; }
export WALLET_RELEASE_SHA="${GITHUB_SHA:-$(git rev-parse HEAD)}"
[[ "$WALLET_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'A full commit SHA is required' >&2; exit 1; }
[[ "$WALLET_RELEASE_SHA" == "$(git rev-parse HEAD)" ]] || { echo 'Release SHA does not match checkout' >&2; exit 1; }
export WALLET_REGISTRY_SERVER
WALLET_REGISTRY_SERVER=$(az acr show --name "$AZURE_CONTAINER_REGISTRY" --query loginServer -o tsv)
umask 077
wallet_tmp=$(mktemp -d)
trap 'rm -rf "$wallet_tmp"' EXIT
# List failure is fatal: an authorization error must never be mistaken for a new app.
az containerapp list -g "$AZURE_RESOURCE_GROUP" -o json > "$wallet_tmp/apps.json"
export WALLET_AZURE_TMP="$wallet_tmp"
node --input-type=module <<'JS'
import fs from 'node:fs';
const env=process.env, root=env.WALLET_AZURE_TMP;
const app=JSON.parse(fs.readFileSync(`${root}/apps.json`)).find(a=>a.name===env.AZURE_CONTAINER_APP);
if(app && (app.tags?.application!=='cherrypay-wallet' || app.tags?.network!=='stellar-testnet')) throw Error('Refusing to overwrite an unrelated Container App');
if(app && app.properties.template.containers.some(c=>c.env?.some(v=>v.name==='WALLET_PAYMENTS_ENABLED' && v.value==='true'))) throw Error('This bootstrap deployment cannot update an activated payment runtime');
if(app && app.properties.template.containers.some(c=>c.env?.some(v=>v.name==='AURORA_INTENTS_ENABLED' && v.value==='true'))) throw Error('This Testnet deployment cannot update an activated Aurora runtime');
if(app?.properties.configuration.secrets?.some(s=>s.name==='aurora-api-key') && !env.AURORA_INTENTS_API_KEY?.trim()) throw Error('Supply the existing AURORA_INTENTS_API_KEY to preserve status recovery across releases');
fs.writeFileSync(`${root}/domains.json`,JSON.stringify(app?.properties.configuration.ingress.customDomains??[]));
JS
for component in api web; do
  az acr build --registry "$AZURE_CONTAINER_REGISTRY" --image "cherrypay-wallet-$component:$WALLET_RELEASE_SHA" --file "apps/$component/Dockerfile.production" "apps/$component" --only-show-errors
done
export WALLET_API_IMAGE WALLET_WEB_IMAGE
api_digest=$(az acr repository show -n "$AZURE_CONTAINER_REGISTRY" --image "cherrypay-wallet-api:$WALLET_RELEASE_SHA" --query digest -o tsv)
web_digest=$(az acr repository show -n "$AZURE_CONTAINER_REGISTRY" --image "cherrypay-wallet-web:$WALLET_RELEASE_SHA" --query digest -o tsv)
[[ "$api_digest" =~ ^sha256:[0-9a-f]{64}$ && "$web_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
WALLET_API_IMAGE="$WALLET_REGISTRY_SERVER/cherrypay-wallet-api@$api_digest"
WALLET_WEB_IMAGE="$WALLET_REGISTRY_SERVER/cherrypay-wallet-web@$web_digest"
node --input-type=module <<'JS'
import fs from 'node:fs';
const e=process.env;
const values={location:e.AZURE_LOCATION,appName:e.AZURE_CONTAINER_APP,environmentId:e.AZURE_CONTAINER_ENVIRONMENT_ID,registryIdentityId:e.AZURE_REGISTRY_IDENTITY_ID,registryServer:e.WALLET_REGISTRY_SERVER,apiImage:e.WALLET_API_IMAGE,webImage:e.WALLET_WEB_IMAGE,databaseUrl:e.WALLET_DATABASE_URL??'',databaseSecretUrl:e.WALLET_DATABASE_SECRET_URL??'',customDomains:JSON.parse(fs.readFileSync(`${e.WALLET_AZURE_TMP}/domains.json`))};
values.auroraApiKey=e.AURORA_INTENTS_API_KEY?.trim()??'';
fs.writeFileSync(`${e.WALLET_AZURE_TMP}/parameters.json`,JSON.stringify({parameters:Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{value}]))}),{mode:0o600});
JS
# No connection strings in command arguments, outputs, or deployment names.
az deployment group create -g "$AZURE_RESOURCE_GROUP" --name "wallet-${WALLET_RELEASE_SHA:0:12}" --template-file infra/azure/wallet.bicep --parameters "@$wallet_tmp/parameters.json" --only-show-errors -o none
app_host=$(az containerapp show -g "$AZURE_RESOURCE_GROUP" -n "$AZURE_CONTAINER_APP" --query properties.configuration.ingress.fqdn -o tsv)
[[ "$app_host" == *.azurecontainerapps.io ]] || exit 1
curl --fail --silent --show-error --retry 12 --retry-all-errors --retry-delay 5 --max-time 15 "https://$app_host/ready" > "$wallet_tmp/ready.json"
node --input-type=module -e 'import fs from "node:fs"; const r=JSON.parse(fs.readFileSync(`${process.env.WALLET_AZURE_TMP}/ready.json`)); if(r.status!=="ready"||r.network!=="TESTNET")process.exit(1);'
printf 'Azure application ready: https://%s\n' "$app_host"
echo 'Next: bind wallet.cherrymoney.co.uk using the DNS and TLS steps in docs/AZURE_DEPLOYMENT.md.'
