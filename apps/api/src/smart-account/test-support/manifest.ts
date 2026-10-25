import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { ACCOUNT_V080_HASH } from '../pinned-adapter.js';
import type { PaymentManifest } from '../manifest.js';
/** Synthetic test input only; no deployment or recovery is claimed. */
export function manifestFixture(): PaymentManifest {
  return {version:1,network:'TESTNET',startLedger:100,relayerPublicKey:Keypair.fromRawEd25519Seed(Buffer.alloc(32,4)).publicKey(),accounts:[{
    walletId:'wallet-1',owner:'11111111-1111-4111-8111-111111111111',address:StrKey.encodeContract(Buffer.alloc(32,7)),
    accountWasmHash:ACCOUNT_V080_HASH,verifierAddress:StrKey.encodeContract(Buffer.alloc(32,8)),verifierWasmHash:'a'.repeat(64),
    primaryRuleId:1,backupRuleId:2,primaryCredentialId:Buffer.from('primary').toString('base64url'),backupCredentialId:Buffer.from('backup').toString('base64url'),
    deploymentTransactionHash:'b'.repeat(64),recoveryTransactionHash:'c'.repeat(64),
  }]};
}
