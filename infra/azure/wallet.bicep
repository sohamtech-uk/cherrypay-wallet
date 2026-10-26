targetScope = 'resourceGroup'

param location string
param appName string = 'cherrypay-wallet-testnet'
@description('Existing Container Apps environment in the same region, with database connectivity.')
param environmentId string
@description('Existing user-assigned identity with AcrPull on the registry.')
param registryIdentityId string
param registryServer string
param apiImage string
param webImage string
@secure()
param databaseUrl string = ''
@description('Versionless Key Vault URL; runtime identity must have access to this secret only.')
param databaseSecretUrl string = ''
@secure()
@description('Optional server-only Aurora key for read-only recovery. This Testnet template never enables funding.')
param auroraApiKey string = ''
@description('Preserved by deploy.sh; do not clear existing certificate bindings on subsequent releases.')
param customDomains array = []

resource wallet 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  tags: { application: 'cherrypay-wallet', network: 'stellar-testnet' }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${registryIdentityId}': {} }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 10
      secrets: concat([empty(databaseSecretUrl) ? { name: 'wallet-database-url', value: databaseUrl } : { name: 'wallet-database-url', keyVaultUrl: databaseSecretUrl, identity: registryIdentityId }], empty(auroraApiKey) ? [] : [{ name: 'aurora-api-key', value: auroraApiKey }])
      registries: [{ server: registryServer, identity: registryIdentityId }]
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'http'
        customDomains: customDomains
      }
    }
    template: {
      terminationGracePeriodSeconds: 60
      scale: { minReplicas: 1, maxReplicas: 1 }
      containers: [
        {
          name: 'api'
          image: apiImage
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat([
            { name: 'NODE_ENV', value: 'production' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'PORT', value: '3001' }
            { name: 'DB_SSL', value: 'true' }
            { name: 'DATABASE_URL', secretRef: 'wallet-database-url' }
            { name: 'WALLET_ORIGIN', value: 'https://wallet.cherrymoney.co.uk' }
            { name: 'WEBAUTHN_RP_ID', value: 'wallet.cherrymoney.co.uk' }
            { name: 'WALLET_PAYMENTS_ENABLED', value: 'false' }
            { name: 'AURORA_INTENTS_NETWORK', value: 'TESTNET' }
            { name: 'AURORA_INTENTS_ENABLED', value: 'false' }
          ], empty(auroraApiKey) ? [] : [{ name: 'AURORA_INTENTS_API_KEY', secretRef: 'aurora-api-key' }])
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/health', port: 3001 }
              periodSeconds: 10
              failureThreshold: 60
              timeoutSeconds: 3
            }
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 3001 }
              periodSeconds: 30
              failureThreshold: 3
              timeoutSeconds: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/ready', port: 3001 }
              periodSeconds: 10
              failureThreshold: 3
              timeoutSeconds: 3
            }
          ]
        }
        {
          name: 'web'
          image: webImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/web-health', port: 8080 }
              periodSeconds: 10
              failureThreshold: 30
              timeoutSeconds: 3
            }
            {
              type: 'Liveness'
              httpGet: { path: '/web-health', port: 8080 }
              periodSeconds: 30
              failureThreshold: 3
              timeoutSeconds: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/ready', port: 8080 }
              periodSeconds: 10
              failureThreshold: 3
              timeoutSeconds: 3
            }
          ]
        }
      ]
    }
  }
}

output appHostname string = wallet.properties.configuration.ingress.fqdn
output domainVerificationId string = wallet.properties.customDomainVerificationId
