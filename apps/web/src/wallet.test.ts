import { describe, expect, it } from 'vitest';
import { isSupportedWalletAddress, NETWORK, validateClassicAddress, validateContractAddress } from './wallet';
describe('testnet wallet boundaries', () => {
 it('never selects mainnet', () => expect(NETWORK).toBe('TESTNET'));
 it('rejects malformed addresses', () => { expect(isSupportedWalletAddress('')).toBe(false); expect(isSupportedWalletAddress('M'.repeat(56))).toBe(false); });
 it('validates address shapes separately', () => { expect(validateClassicAddress('G'+'A'.repeat(55))).toBe(true); expect(validateContractAddress('C'+'A'.repeat(55))).toBe(true); });
});
