#!/usr/bin/env python3
"""Provision the dedicated Testnet database and app. Azure CLI must be signed in.

Credentials are generated/reused inside this process, retained in the wallet vault,
passed only through private parameter files, and never emitted to the console.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
from urllib.parse import quote
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
TAGS = {"application": "cherrypay-wallet", "network": "stellar-testnet"}


def az(*args):
    result = subprocess.run(["az", *args, "--only-show-errors", "-o", "json"], capture_output=True, text=True)
    if result.returncode:
        # Azure failures can contain secure parameter echoes. Never relay stderr.
        raise RuntimeError("Azure operation failed: " + " ".join(args[:3]))
    return json.loads(result.stdout) if result.stdout.strip() else None


def parts(resource_id):
    m = re.fullmatch(r"/subscriptions/([^/]+)/resourceGroups/([^/]+)/providers/([^/]+)/([^/]+)/([^/]+)", resource_id, re.I)
    if not m:
        raise ValueError("Expected a full top-level Azure resource ID")
    return m.groups()


def validate_network(c, network, environment):
    target = ipaddress.ip_network(c["postgresSubnetPrefix"])
    if target.version != 4 or target.prefixlen > 28 or not any(target.subnet_of(ipaddress.ip_network(p)) for p in network["addressSpace"]["addressPrefixes"]):
        raise ValueError("PostgreSQL subnet must fit inside the existing VNet and be /28 or larger")
    apps_id = environment["properties"]["vnetConfiguration"]["infrastructureSubnetId"]
    if not apps_id.lower().startswith(c["vnetId"].lower()+"/subnets/"):
        raise ValueError("Container Apps environment belongs to a different VNet")
    found_apps = False
    for subnet in network.get("subnets", []):
        prefixes = subnet.get("addressPrefixes") or [subnet["addressPrefix"]]
        if subnet["id"].lower() == apps_id.lower():
            if prefixes != [c["appsSubnetPrefix"]]:
                raise ValueError("Application subnet prefix does not match Azure")
            found_apps = True
        if subnet["name"] == "snet-wallet-postgres":
            if prefixes != [str(target)] or {d["serviceName"] for d in subnet.get("delegations", [])} != {"Microsoft.DBforPostgreSQL/flexibleServers"}:
                raise ValueError("Existing wallet subnet does not match the requested configuration")
        elif any(target.overlaps(ipaddress.ip_network(p)) for p in prefixes):
            raise ValueError("PostgreSQL subnet overlaps an existing subnet")
    if not found_apps:
        raise ValueError("Application subnet not found")


def owned(resource):
    return all(resource.get("tags", {}).get(k) == v for k, v in TAGS.items())


def deploy(c, template, parameters, scratch):
    filename = Path(scratch)/(template+".parameters.json")
    filename.write_text(json.dumps({"parameters": {k: {"value": v} for k, v in parameters.items()}}))
    filename.chmod(0o600)
    try:
        az("deployment", "group", "create", "-g", c["resourceGroup"], "--name", "wallet-"+template,
           "--template-file", str(ROOT/"infra/azure"/(template+".bicep")), "--parameters", "@"+str(filename))
    finally:
        filename.unlink(missing_ok=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--apply", action="store_true", help="Provision after read-only preflight")
    args=parser.parse_args()
    c=json.loads(Path(args.config).read_text())
    required=["subscriptionId", "resourceGroup", "location", "environmentId", "registryId", "vnetId", "appsSubnetPrefix", "postgresSubnetPrefix", "serverName", "vaultName", "appName"]
    if set(c) != set(required) or not all(isinstance(c[k], str) and c[k] for k in required):
        raise ValueError("Configuration fields do not match the bootstrap contract")
    if az("account", "show")["id"] != c["subscriptionId"]:
        raise ValueError("Select the intended Azure subscription before running bootstrap")
    resources={k:parts(c[k]) for k in ["environmentId","registryId","vnetId"]}
    if any(v[0].lower()!=c["subscriptionId"].lower() for v in resources.values()):
        raise ValueError("Cross-subscription resource access is not supported")
    if resources["environmentId"][2:4] != ("Microsoft.App", "managedEnvironments") or resources["registryId"][2:4] != ("Microsoft.ContainerRegistry", "registries") or resources["vnetId"][2:4] != ("Microsoft.Network", "virtualNetworks"):
        raise ValueError("Azure resource types do not match the bootstrap contract")
    for key in ["serverName", "appName"]:
        if not re.fullmatch(r"[a-z][a-z0-9-]{2,30}[a-z0-9]", c[key]): raise ValueError("Invalid resource name")
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,22}[a-z0-9]",c["vaultName"]): raise ValueError("Invalid vault name")
    env=az("containerapp", "env", "show", "--ids", c["environmentId"])
    network=az("network", "vnet", "show", "--ids", c["vnetId"])
    registry=az("acr", "show", "-g", resources["registryId"][1], "-n", resources["registryId"][4])
    if registry.get("roleAssignmentMode") not in [None,"LegacyRegistryPermissions"]:
        raise ValueError("Registry requires repository-scoped ABAC roles; this bootstrap uses AcrPull")
    if env["location"].replace(" ", "").lower()!=c["location"].replace(" ", "").lower():
        raise ValueError("App and environment regions differ")
    validate_network(c,network,env)
    for nsg in az("network", "nsg", "list", "-g", resources["vnetId"][1]):
        if nsg["name"] == "nsg-cherrypay-wallet-postgres" and not owned(nsg): raise ValueError("Existing network security group is not wallet-owned")
    existing_group=next((g for g in az("group", "list") if g["name"].lower()==c["resourceGroup"].lower()),None)
    if existing_group and not owned(existing_group): raise ValueError("Refusing to modify an unrelated resource group")
    existing_resources=az("resource","list","-g",c["resourceGroup"]) if existing_group else []
    if any(not owned(r) for r in existing_resources if r["type"] in ["Microsoft.KeyVault/vaults","Microsoft.DBforPostgreSQL/flexibleServers","Microsoft.App/containerApps"]):
        raise ValueError("An existing resource is not wallet-owned")
    if existing_group:
        for app in az("containerapp","list","-g",c["resourceGroup"]):
            if any(v.get("name")=="WALLET_PAYMENTS_ENABLED" and v.get("value")=="true" for container in app["properties"]["template"]["containers"] for v in container.get("env",[])):
                raise ValueError("Bootstrap cannot modify an activated payment environment")
    sha=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
    if subprocess.check_output(["git","status","--porcelain"],cwd=ROOT,text=True).strip(): raise ValueError("A clean checkout is required")
    print(json.dumps({"mode":"apply" if args.apply else "plan","commit":sha,"resourceGroup":c["resourceGroup"],"server":c["serverName"],"databaseSku":"Standard_B1ms / 32 GiB / private access / 7-day backup","app":c["appName"],"subnet":c["postgresSubnetPrefix"],"paymentsEnabled":False}),flush=True)
    if not args.apply: return
    if not existing_group:
        az("group","create","-n",c["resourceGroup"],"-l",c["location"],"--tags",*[k+"="+v for k,v in TAGS.items()])
    with tempfile.TemporaryDirectory(prefix="wallet-azure-") as scratch:
        operator=az("ad","signed-in-user","show","--query","id")
        print("Creating wallet vault and operator-scoped secret access",flush=True)
        deploy(c,"vault",{"location":c["location"],"vaultName":c["vaultName"],"operatorObjectId":operator},scratch)
        for attempt in range(30):
            try:
                names=az("keyvault","secret","list","--vault-name",c["vaultName"],"--query","[].name")
                break
            except RuntimeError:
                if attempt==29: raise
                time.sleep(5)
        def password(name):
            # Guarantee Azure's character-category requirements while retaining 256 random bits.
            return az("keyvault","secret","show","--vault-name",c["vaultName"],"--name",name,"--query","value") if name in names else "Cp1_"+secrets.token_hex(32)
        if any(r["name"]==c["serverName"] and r["type"]=="Microsoft.DBforPostgreSQL/flexibleServers" for r in existing_resources) and not {"postgres-administrator-password","postgres-runtime-password"}.issubset(names):
            raise ValueError("Existing database credentials are missing; restore the wallet secrets before retrying")
        admin_password=password("postgres-administrator-password")
        runtime_password=password("postgres-runtime-password")
        if not all(re.fullmatch(r"[a-zA-Z0-9_-]{32,128}",v) for v in [admin_password,runtime_password]): raise ValueError("Stored wallet credential format is invalid")
        print("Provisioning private PostgreSQL and dedicated wallet identities",flush=True)
        deploy(c,"database",dict(location=c["location"],serverName=c["serverName"],vaultName=c["vaultName"],vnetId=c["vnetId"],vnetResourceGroup=resources["vnetId"][1],vnetName=resources["vnetId"][4],subnetPrefix=c["postgresSubnetPrefix"],appsSubnetPrefix=c["appsSubnetPrefix"],registryResourceGroup=resources["registryId"][1],registryName=resources["registryId"][4],administratorPassword=admin_password,runtimePassword=runtime_password),scratch)
        images={}
        for component in ["api","web"]:
            print("Building production "+component+" image",flush=True)
            tag="cherrypay-wallet-"+component+":"+sha
            az("acr","build","-r",resources["registryId"][4],"-t",tag,"-f",str(ROOT/"apps"/component/"Dockerfile.production"),str(ROOT/"apps"/component),"--no-logs")
            digest=az("acr","repository","show","-n",resources["registryId"][4],"--image",tag,"--query","digest")
            if not re.fullmatch(r"sha256:[0-9a-f]{64}",digest): raise ValueError("Registry digest is invalid")
            images[component]=registry["loginServer"]+"/cherrypay-wallet-"+component+"@"+digest
        identity_base=f'/subscriptions/{c["subscriptionId"]}/resourceGroups/{c["resourceGroup"]}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/'
        host=c["serverName"]+".postgres.database.azure.com"
        admin_url="postgresql://walletadmin:"+quote(admin_password,safe="")+"@"+host+":5432/cherrypay_wallet"
        print("Initializing restricted database role through a private-network job",flush=True)
        deploy(c,"database-job",dict(location=c["location"],environmentId=c["environmentId"],registryServer=registry["loginServer"],identityId=identity_base+"id-cherrypay-wallet-bootstrap",apiImage=images["api"],administratorUrl=admin_url,runtimePassword=runtime_password),scratch)
        job="caj-cpw-wallet-db-init"
        execution=az("containerapp","job","start","-g",c["resourceGroup"],"-n",job)["name"]
        for attempt in range(90):
            result=az("containerapp","job","execution","show","-g",c["resourceGroup"],"-n",job,"--job-execution-name",execution)
            status=result["properties"]["status"]
            if status=="Succeeded": break
            if status in ["Failed","Stopped"]: raise RuntimeError("Private database initialization failed")
            if attempt==89: raise RuntimeError("Private database initialization timed out")
            time.sleep(10)
        # Ephemeral job definition contains administrator secret references. Remove it after success.
        az("containerapp","job","delete","-g",c["resourceGroup"],"-n",job,"--yes")
        apps=az("containerapp","list","-g",c["resourceGroup"])
        app=next((a for a in apps if a["name"]==c["appName"]),None)
        if app and any(v.get("name")=="WALLET_PAYMENTS_ENABLED" and v.get("value")=="true" for container in app["properties"]["template"]["containers"] for v in container.get("env",[])):
            raise ValueError("Bootstrap cannot replace an activated payment runtime")
        domains=app["properties"]["configuration"]["ingress"].get("customDomains",[]) if app else []
        print("Deploying wallet app with Key Vault secret reference and payments disabled",flush=True)
        deploy(c,"wallet",dict(location=c["location"],appName=c["appName"],environmentId=c["environmentId"],registryIdentityId=identity_base+"id-cherrypay-wallet-runtime",registryServer=registry["loginServer"],apiImage=images["api"],webImage=images["web"],databaseSecretUrl="https://"+c["vaultName"]+".vault.azure.net/secrets/wallet-database-url",customDomains=domains),scratch)
        app=az("containerapp","show","-g",c["resourceGroup"],"-n",c["appName"])
        hostname=app["properties"]["configuration"]["ingress"]["fqdn"]
        if not hostname.endswith(".azurecontainerapps.io"): raise ValueError("Unexpected Azure hostname")
        for attempt in range(30):
            try:
                with urlopen("https://"+hostname+"/ready",timeout=15) as response: ready=json.load(response)
                if ready=={"status":"ready","network":"TESTNET"}: break
            except Exception: pass
            if attempt==29: raise RuntimeError("Wallet readiness did not pass")
            time.sleep(5)
        print(json.dumps({"status":"ready","hostname":hostname,"verificationId":app["properties"]["customDomainVerificationId"],"apiImage":images["api"],"webImage":images["web"],"paymentsEnabled":False}),flush=True)


if __name__=="__main__":
    try: main()
    except Exception as error:
        # Only our own constant validation errors are printable; never raw subprocess/URL errors.
        if type(error) in [ValueError, RuntimeError]: print(str(error),flush=True)
        else: print("Wallet bootstrap failed; inspect Azure operation status",flush=True)
        raise SystemExit(1)
