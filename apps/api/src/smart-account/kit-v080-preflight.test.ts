import { describe, expect, it } from 'vitest';
import { TESTNET_V080, validateKitV080DeploymentConfig } from './kit-v080-preflight.js';
import { SMART_ACCOUNT_KIT } from './kit-manifest.js';

const approved = {
  networkPassphrase: TESTNET_V080.networkPassphrase,
  accountWasmHash: TESTNET_V080.accountWasmHash,
  verifierAddress: TESTNET_V080.verifierAddress,
  verifierWasmHash: TESTNET_V080.verifierWasmHash,
};

describe('Smart Account Kit v0.8.0 deployment preflight', () => {
  it('accepts only the pinned Testnet contract and verifier', () => {
    expect(validateKitV080DeploymentConfig(approved).validated).toBe(true);
  });
  it('rejects the known legacy account artifact', () => {
    expect(() => validateKitV080DeploymentConfig({...approved, accountWasmHash: SMART_ACCOUNT_KIT.accountWasmHash})).toThrow();
  });
  it('rejects a different network', () => {
    expect(() => validateKitV080DeploymentConfig({...approved, networkPassphrase: 'Public Global Stellar Network ; September 2015'})).toThrow();
  });
  it('rejects a different verifier', () => {
    expect(() => validateKitV080DeploymentConfig({...approved, verifierAddress: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'})).toThrow();
  });
  it('rejects a mismatched verifier WASM', () => {
    expect(() => validateKitV080DeploymentConfig({...approved, verifierWasmHash: '0'.repeat(64)})).toThrow();
  });
});
