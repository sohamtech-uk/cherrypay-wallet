import { describe, expect, it, vi } from 'vitest';
import { Account, Address, Keypair, SorobanDataBuilder, Transaction, rpc } from '@stellar/stellar-sdk';
import { PASSPHRASE, type Outcome, type TransferEvent } from '../payments/model.js';
import { transferOperation } from '../payments/stellar.js';
import { StellarFundingChain, TESTNET_ALLOCATION_STROOPS, verifyAllocation } from './contract-funding.js';
const source=Keypair.random(),address=Address.contract(Buffer.alloc(32,4)).toString();
function fixture(){
 const server={getNetwork:vi.fn(async()=>({passphrase:String(PASSPHRASE)})),getAccount:vi.fn(async()=>new Account(source.publicKey(),'10')),
  simulateTransaction:vi.fn(async()=>({_parsed:true,id:'sim',latestLedger:200,events:[],minResourceFee:'500',transactionData:new SorobanDataBuilder().setResourceFee('500'),result:{auth:[],retval:new Address(address).toScVal()}})),sendTransaction:vi.fn()};
 return {server,chain:new StellarFundingChain(server as unknown as rpc.Server,source,vi.fn())};
}
describe('Testnet allocation transaction',()=>{
 it('signs exactly 100,000 XLM to a C-address with treasury authority and never broadcasts during prepare',async()=>{
  const {server,chain}=fixture(),p=await chain.prepare(address),tx=new Transaction(p.signedXdr,PASSPHRASE);
  expect(tx.source).toBe(source.publicKey());expect(tx.operations).toHaveLength(1);
  expect(tx.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().hostFunction().toXDR('base64')).toBe(transferOperation(source.publicKey(),address,TESTNET_ALLOCATION_STROOPS).body().invokeHostFunctionOp().hostFunction().toXDR('base64'));
  expect(source.verify(tx.hash(),tx.signatures[0].signature())).toBe(true);
  expect(server.simulateTransaction).toHaveBeenCalledWith(expect.any(Transaction),undefined,'enforce');
  expect(server.sendTransaction).not.toHaveBeenCalled();
 });
 it('rejects mainnet, G recipients and excessive fees',async()=>{
  const {server,chain}=fixture();await expect(chain.prepare(source.publicKey())).rejects.toThrow('CONTRACT_ADDRESS_REQUIRED');
  server.getNetwork.mockResolvedValueOnce({passphrase:'mainnet'});await expect(chain.prepare(address)).rejects.toThrow('RPC_NETWORK_MISMATCH');
  const sim=await server.simulateTransaction();server.simulateTransaction.mockResolvedValue({...sim,minResourceFee:'10000001',transactionData:new SorobanDataBuilder().setResourceFee('10000001')});
  await expect(chain.prepare(address)).rejects.toThrow('FUNDING_FEE_CAP_EXCEEDED');
 });
 it('requires the exact transfer receipt rather than an arbitrary positive wallet balance',()=>{
  const e={from:source.publicKey(),to:address,amountStroops:TESTNET_ALLOCATION_STROOPS,ledger:201} as TransferEvent;
  const success=(events:TransferEvent[]):Outcome=>({status:'SUCCESS',transactionHash:'a'.repeat(64),events});
  expect(verifyAllocation(success([e]),source.publicKey(),address)).toBe(201);
  for(const events of [[],[e,e],[{...e,amountStroops:'100000000000'}],[{...e,to:source.publicKey()}]])expect(()=>verifyAllocation(success(events),source.publicKey(),address)).toThrow();
 });
});
