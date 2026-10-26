import { StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { isSupportedWalletAddress, NETWORK, validateClassicAddress, validateContractAddress } from './wallet';
describe('testnet wallet boundaries', () => {
 it('never selects mainnet', () => expect(NETWORK).toBe('TESTNET'));
 it('rejects malformed addresses', () => { expect(isSupportedWalletAddress('')).toBe(false); expect(isSupportedWalletAddress('M'.repeat(56))).toBe(false); });
 it('validates both address checksums, not just their shape', () => { expect(validateClassicAddress(StrKey.encodeEd25519PublicKey(Buffer.alloc(32,1)))).toBe(true); expect(validateContractAddress(StrKey.encodeContract(Buffer.alloc(32,1)))).toBe(true); expect(validateClassicAddress('G'+'A'.repeat(55))).toBe(false); expect(validateContractAddress('C'+'A'.repeat(55))).toBe(false); });
});

