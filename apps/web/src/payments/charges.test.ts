import { describe, expect, it } from 'vitest';
import { paymentBreakdown, type Quote } from './model.js';
const quote: Quote = { network:'TESTNET',id:'preview',from:'source',destination:'destination',
  amountStroops:'10000001',feeStroops:'10000000',feePayer:'sponsor',spendableStroops:'1000000000',
  expiresAt:'2026-10-27T00:00:00Z' };
describe('payment breakdown uses exact stroops without inventing fees',()=>{
  it('distinguishes sponsor allowance from wallet debit',()=>{
    expect(paymentBreakdown(quote)).toEqual({
      transferStroops:'10000001',serviceFeeStroops:'0',maximumNetworkFeeStroops:'10000000',
      walletNetworkFeeLimitStroops:'0',sponsorNetworkFeeLimitStroops:'10000000',
      maximumWalletDebitStroops:'10000001'
    });
  });
  it('adds fee allowance to the debit only when paid by the wallet',()=>{
    expect(paymentBreakdown({...quote,feePayer:'wallet'})).toMatchObject({
      maximumWalletDebitStroops:'20000001',walletNetworkFeeLimitStroops:'10000000',sponsorNetworkFeeLimitStroops:'0'
    });
  });
  it('preserves stroop precision for very large integers',()=>{
    expect(paymentBreakdown({...quote,amountStroops:'9007199254740993',feeStroops:'1',feePayer:'wallet'}).maximumWalletDebitStroops)
      .toBe('9007199254740994');
  });
});
