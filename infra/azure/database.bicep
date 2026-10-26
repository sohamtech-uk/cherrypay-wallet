param location string
param serverName string
param vaultName string
param vnetId string
param vnetResourceGroup string
param vnetName string
param subnetPrefix string
param appsSubnetPrefix string
param registryResourceGroup string
param registryName string
@secure()
param administratorPassword string
@secure()
param runtimePassword string
var tags = { application: 'cherrypay-wallet', network: 'stellar-testnet' }
var databaseName = 'cherrypay_wallet'
var databaseHost = '${serverName}.postgres.database.azure.com'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: vaultName }
// Persist both credentials before attempting server provisioning, so failures can resume safely.
resource adminSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'postgres-administrator-password'
  properties: { value: administratorPassword }
}
resource runtimeSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'postgres-runtime-password'
  properties: { value: runtimePassword }
}
resource connectionSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: 'wallet-database-url'
  properties: { value: 'postgresql://wallet_runtime:${uriComponent(runtimePassword)}@${databaseHost}:5432/${databaseName}' }
}
resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-cherrypay-wallet-runtime'
  location: location
  tags: tags
}
resource bootstrapIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-cherrypay-wallet-bootstrap'
  location: location
  tags: tags
}
resource readConnection 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(connectionSecret.id, runtimeIdentity.id, 'wallet-secret-reader')
  scope: connectionSecret
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}
module pull 'registry-access.bicep' = {
  name: 'wallet-registry-access'
  scope: resourceGroup(registryResourceGroup)
  params: { registryName: registryName, runtimePrincipalId: runtimeIdentity.properties.principalId, bootstrapPrincipalId: bootstrapIdentity.properties.principalId }
}
module subnet 'database-subnet.bicep' = {
  name: 'wallet-private-subnet'
  scope: resourceGroup(vnetResourceGroup)
  params: { location: location, vnetName: vnetName, subnetPrefix: subnetPrefix, appsSubnetPrefix: appsSubnetPrefix }
}
resource dns 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'wallet.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}
resource link 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: dns
  name: 'wallet-application-network'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnetId } }
}
resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '17'
    administratorLogin: 'walletadmin'
    administratorLoginPassword: administratorPassword
    authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' }
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Disabled', delegatedSubnetResourceId: subnet.outputs.id, privateDnsZoneArmResourceId: dns.id }
  }
  dependsOn: [adminSecret, runtimeSecret, connectionSecret, link]
}
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
output databaseHost string = server.properties.fullyQualifiedDomainName
output runtimeIdentityId string = runtimeIdentity.id
output bootstrapIdentityId string = bootstrapIdentity.id
output databaseSecretUrl string = '${vault.properties.vaultUri}secrets/wallet-database-url'
