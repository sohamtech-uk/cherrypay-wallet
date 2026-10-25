param location string
param vnetName string
param subnetName string = 'snet-wallet-postgres'
param subnetPrefix string
param appsSubnetPrefix string
resource network 'Microsoft.Network/virtualNetworks@2024-05-01' existing = { name: vnetName }
resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-cherrypay-wallet-postgres'
  location: location
  tags: { application: 'cherrypay-wallet', network: 'stellar-testnet' }
  properties: {
    securityRules: [
      {
        name: 'AllowWalletApplicationSubnet'
        properties: { priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: appsSubnetPrefix, sourcePortRange: '*', destinationAddressPrefix: subnetPrefix, destinationPortRange: '5432' }
      }
      {
        name: 'AllowPostgreSQLSubnet'
        properties: { priority: 110, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: subnetPrefix, sourcePortRange: '*', destinationAddressPrefix: subnetPrefix, destinationPortRange: '5432' }
      }
      {
        name: 'DenyOtherDatabaseClients'
        properties: { priority: 120, direction: 'Inbound', access: 'Deny', protocol: 'Tcp', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: subnetPrefix, destinationPortRange: '5432' }
      }
    ]
  }
}
resource subnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' = {
  parent: network
  name: subnetName
  properties: {
    addressPrefix: subnetPrefix
    delegations: [{ name: 'postgresql', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
    networkSecurityGroup: { id: nsg.id }
  }
}
output id string = subnet.id
