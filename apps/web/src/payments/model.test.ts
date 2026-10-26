import { describe, expect, it } from 'vitest';
import { StrKey } from '@stellar/stellar-sdk';
import { checkQuote, destinationError, explorerLink, NETWORK, statusLabel, stroops, xlm, type Attempt, type Quote } from './model';
const address = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const intent = { network: NETWORK, from: address, destination: address, amountStroops: '10000001' };
const quote: Quote = { ...intent, id: 'quote', feeStroops: '100', feePayer: 'wallet', spendableStroops: '10000101', expiresAt: new Date(Date.now() + 60000).toISOString() };
describe('payment boundaries', () => {
  it('preserves stroop precision without floating point', () => { expect(stroops('900719925.4740993')).toBe(9007199254740993n); expect(xlm('1')).toBe('0.0000001'); });
  it.each(['1e3', '-1', '0.00000001', '1,000', '1.', ' 1', '922337203685.4775808'])('rejects ambiguous or overflowing amount %s', value => expect(() => stroops(value)).toThrow());
  it('validates checksum and configured routes', () => { expect(destinationError(address, ['classic'])).toBe(''); expect(destinationError(address.slice(0, -1) + 'A', ['classic'])).not.toBe(''); expect(destinationError(address, ['contract'])).toContain('not enabled'); expect(destinationError('M'.repeat(69), ['classic'])).not.toBe(''); });
  it('checks quote binding, expiry, funds and sponsorship', () => { expect(() => checkQuote(quote, intent)).not.toThrow(); expect(() => checkQuote({ ...quote, destination: 'different' }, intent)).toThrow(); expect(() => checkQuote({ ...quote, expiresAt: 'invalid' }, intent)).toThrow(); expect(() => checkQuote({ ...quote, spendableStroops: '10000001' }, intent)).toThrow('Insufficient'); expect(() => checkQuote({ ...quote, feePayer: 'sponsor', spendableStroops: '10000001' }, intent)).not.toThrow(); });
  it('never calls an unverified result successful or supplies an unsafe receipt', () => { const attempt: Attempt = { ...intent, id: 'a', status: 'confirmed', verified: false, feeStroops: '100', createdAt: new Date().toISOString(), transactionHash: 'a'.repeat(64) }; expect(statusLabel(attempt)).toBe('Awaiting verification'); expect(explorerLink(attempt)).toBeUndefined(); expect(explorerLink({ ...attempt, verified: true })).toContain('/testnet/tx/'); expect(explorerLink({ ...attempt, verified: true, transactionHash: 'javascript:alert(1)' })).toBeUndefined(); });
});
