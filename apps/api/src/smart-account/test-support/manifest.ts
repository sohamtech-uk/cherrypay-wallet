import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { ACCOUNT_V080_HASH } from '../pinned-adapter.js';
import { TESTNET_V080 } from '../kit-v080-preflight.js';
import type { PaymentManifest } from '../manifest.js';
/** Synthetic test input only; no deployment or recovery is claimed. */
export function manifestFixture(): PaymentManifest {
  return {version:1,network:'TESTNET',startLedger:100,relayerPublicKey:Keypair.fromRawEd25519Seed(Buffer.alloc(32,4)).publicKey(),accounts:[{
    walletId:'wallet-1',owner:'owner@example.com',address:StrKey.encodeContract(Buffer.alloc(32,7)),
    accountWasmHash:ACCOUNT_V080_HASH,verifierAddress:TESTNET_V080.verifierAddress,verifierWasmHash:TESTNET_V080.verifierWasmHash,
    primaryRuleId:1,backupRuleId:2,primaryCredentialId:Buffer.from('primary').toString('base64url'),backupCredentialId:Buffer.from('backup').toString('base64url'),
    deploymentTransactionHash:'b'.repeat(64),recoveryTransactionHash:'c'.repeat(64),
  }]};
}
