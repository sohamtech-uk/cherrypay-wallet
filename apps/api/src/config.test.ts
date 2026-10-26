import {describe,it,expect} from 'vitest';import {getConfig,STELLAR_NETWORK,TESTNET_PASSPHRASE} from './config.js';
describe('strict Testnet and WebAuthn origin',()=>{
 it('uses only Stellar Testnet',()=>{expect(STELLAR_NETWORK).toBe('TESTNET');expect(TESTNET_PASSPHRASE).toBe('Test SDF Network ; September 2015');});
 it('rejects HTTP remote origins',()=>expect(()=>getConfig({WALLET_ORIGIN:'http://example.com'})).toThrow());
 it('rejects mismatched RP IDs',()=>expect(()=>getConfig({WALLET_ORIGIN:'https://wallet.example.com',WEBAUTHN_RP_ID:'evil.com'})).toThrow());
 it('accepts HTTPS wallet origin',()=>expect(getConfig({WALLET_ORIGIN:'https://wallet.example.com',WEBAUTHN_RP_ID:'example.com'}).rpID).toBe('example.com'));
});
