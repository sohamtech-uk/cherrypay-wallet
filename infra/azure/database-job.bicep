param location string
param environmentId string
param registryServer string
param identityId string
param apiImage string
@secure()
param administratorUrl string
@secure()
param runtimePassword string
resource job 'Microsoft.App/jobs@2025-01-01' = {
  name: 'caj-cherrypay-wallet-database-init'
  location: location
  tags: { application: 'cherrypay-wallet', network: 'stellar-testnet' }
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identityId}': {} } }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 2
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registryServer, identity: identityId }]
      secrets: [{ name: 'administrator-url', value: administratorUrl }, { name: 'runtime-password', value: runtimePassword }]
    }
    template: {
      containers: [{
        name: 'initialize'
        image: apiImage
        command: ['node', 'dist/database-bootstrap-cli.js']
        resources: { cpu: json('0.25'), memory: '0.5Gi' }
        env: [{ name: 'DATABASE_ADMIN_URL', secretRef: 'administrator-url' }, { name: 'DATABASE_RUNTIME_PASSWORD', secretRef: 'runtime-password' }]
      }]
    }
  }
}
