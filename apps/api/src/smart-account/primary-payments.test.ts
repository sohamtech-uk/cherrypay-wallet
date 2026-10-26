import { expect,it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { configuredPrimaryPayments } from './primary-payments.js';
import type { AutomaticDeploymentService } from './automatic-deployment.js';
const deployments={} as AutomaticDeploymentService;
it('defaults off and requires an explicit isolated primary payment mode',async()=>{
  expect(await configuredPrimaryPayments({},undefined)).toBeUndefined();
  await expect(configuredPrimaryPayments({WALLET_PRIMARY_PAYMENTS_ENABLED:'yes'},deployments)).rejects.toThrow('INVALID_PRIMARY_PAYMENT_FLAG');
  const enabled={WALLET_PRIMARY_PAYMENTS_ENABLED:'true'};
  for(const [env,deployment] of [[enabled,undefined],[{...enabled,WALLET_PAYMENTS_ENABLED:'true'},deployments],[{...enabled,WALLET_PAYMENT_MANIFEST:'/manifest'},deployments]] as const)
    await expect(configuredPrimaryPayments(env,deployment)).rejects.toThrow('PRIMARY_PAYMENT_MODE_CONFLICT');
  await expect(configuredPrimaryPayments(enabled,deployments)).rejects.toThrow('PAYMENT_RELAYER_CONFIGURATION_REQUIRED');
});
it('requires a dedicated fee source with the expected public identity before any RPC',async()=>{
  const key=Keypair.random(),other=Keypair.random();
  const env={WALLET_PRIMARY_PAYMENTS_ENABLED:'true',STELLAR_RELAYER_SECRET:key.secret(),STELLAR_RELAYER_PUBLIC_KEY:key.publicKey(),STELLAR_DEPLOYER_PUBLIC_KEY:key.publicKey()};
  await expect(configuredPrimaryPayments(env,deployments)).rejects.toThrow('DEDICATED_PAYMENT_RELAYER_REQUIRED');
  await expect(configuredPrimaryPayments({...env,STELLAR_DEPLOYER_PUBLIC_KEY:other.publicKey(),STELLAR_RELAYER_PUBLIC_KEY:other.publicKey()},deployments)).rejects.toThrow('DEDICATED_PAYMENT_RELAYER_REQUIRED');
});
