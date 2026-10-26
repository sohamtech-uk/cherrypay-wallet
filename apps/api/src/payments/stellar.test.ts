import { describe, expect, it, vi } from 'vitest';
import { Account, Address, Keypair, nativeToScVal, Operation, rpc, SorobanDataBuilder, StrKey, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { assertTransferAuthorization, bindAuthorization, decodeTransfer, StellarChain, transferOperation, verifyOutcome } from './stellar.js';
import { NATIVE_SAC, PASSPHRASE, type Prepared } from './model.js';
import { destination, intent, wallet } from './test-fixtures.js';
const relayer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
function auth() {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: new Address(wallet.address).toScAddress(), nonce: xdr.Int64.fromString('123'), signatureExpirationLedger: 130, signature: xdr.ScVal.scvVoid() })),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(transferOperation(wallet.address, destination, intent.amountStroops).body().invokeHostFunctionOp().hostFunction().invokeContract()), subInvocations: [] }),
  });
}
function prepared(): Prepared {
  const op = transferOperation(wallet.address, destination, intent.amountStroops);
  op.body().invokeHostFunctionOp().auth([auth()]);
  const tx = new TransactionBuilder(new Account(relayer.publicKey(), '1'), { fee: '100', networkPassphrase: PASSPHRASE }).addOperation(op).setTimeout(120).build();
  return { transactionXdr: tx.toXDR(), authXdr: auth().toXDR('base64'), feeStroops: intent.maxFeeStroops, expiresAt: Number(tx.timeBounds!.maxTime) * 1000, expirationLedger: 130, ledger: 100 };
}
function signedAuth() { const a = auth(); a.credentials().address().signature(nativeToScVal(Buffer.from('contract-specific-signature'))); return a; }
function event(contract = NATIVE_SAC, value = nativeToScVal(BigInt(intent.amountStroops), { type: 'i128' })) {
  return new xdr.ContractEvent({ ext: new xdr.ExtensionPoint(0), contractId: StrKey.decodeContract(contract) as unknown as xdr.Hash, type: xdr.ContractEventType.contract(), body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics: [xdr.ScVal.scvSymbol('transfer'), new Address(wallet.address).toScVal(), new Address(destination).toScVal()], data: value })) });
}
function serverMock() {
  return { getNetwork: vi.fn(async () => ({ passphrase: String(PASSPHRASE) })), getAccount: vi.fn(async () => new Account(relayer.publicKey(), '1')),
    simulateTransaction: vi.fn(async () => ({ id: '1', _parsed: true, latestLedger: 100, events: [], minResourceFee: '500', transactionData: new SorobanDataBuilder().setResourceFee('500'), result: { auth: [auth()], retval: xdr.ScVal.scvVoid() } })),
    sendTransaction: vi.fn(), getTransaction: vi.fn(), getEvents: vi.fn() };
}
describe('native SAC authorization boundary', () => {
  it('builds a native SAC transfer with exact i128 stroops', () => {
    const fn = transferOperation(wallet.address, destination, intent.amountStroops).body().invokeHostFunctionOp().hostFunction().invokeContract();
    expect(Address.fromScAddress(fn.contractAddress()).toString()).toBe(NATIVE_SAC);
    expect(fn.functionName().toString()).toBe('transfer'); expect(fn.args()[2].i128().lo().toString()).toBe(intent.amountStroops);
  });
  it('only replaces the signature in the recorded authorization', () => {
    const tx = bindAuthorization(wallet, intent, prepared(), signedAuth().toXDR('base64'));
    expect(tx.operations).toHaveLength(1); expect(tx.signatures).toHaveLength(0);
  });
  it.each(['recipient', 'amount', 'nonce', 'expiry', 'address', 'nested', 'source'])('rejects changed %s authorization', change => {
    const a = signedAuth();
    if (change === 'recipient') a.rootInvocation().function().contractFn().args()[1] = new Address(relayer.publicKey()).toScVal();
    if (change === 'amount') a.rootInvocation().function().contractFn().args()[2] = nativeToScVal(1n, { type: 'i128' });
    if (change === 'nonce') a.credentials().address().nonce(xdr.Int64.fromString('124'));
    if (change === 'expiry') a.credentials().address().signatureExpirationLedger(999);
    if (change === 'address') a.credentials().address().address(new Address(relayer.publicKey()).toScAddress());
    if (change === 'nested') a.rootInvocation().subInvocations([auth().rootInvocation()]);
    if (change === 'source') a.credentials(xdr.SorobanCredentials.sorobanCredentialsSourceAccount());
    expect(() => bindAuthorization(wallet, intent, prepared(), a.toXDR('base64'))).toThrow();
  });
  it('rejects unsigned authorization and additional transaction operations', () => {
    expect(() => bindAuthorization(wallet, intent, prepared(), auth().toXDR('base64'))).toThrow('SIGNATURE_REQUIRED');
    const p = prepared(); const tx = new Transaction(p.transactionXdr, PASSPHRASE);
    p.transactionXdr = TransactionBuilder.cloneFrom(tx).addOperation(Operation.manageData({ name: 'unexpected', value: 'data' })).build().toXDR();
    expect(() => bindAuthorization(wallet, intent, p, signedAuth().toXDR('base64'))).toThrow('PREPARED_OPERATION_FORBIDDEN');
  });
  it('enforces deployed contract authorization before fee-only signing and never submits during authorization', async () => {
    const server = serverMock(); const chain = new StellarChain(server as unknown as rpc.Server, relayer);
    const result = await chain.authorize(wallet, intent, prepared(), signedAuth().toXDR('base64'));
    expect(server.simulateTransaction).toHaveBeenCalledWith(expect.any(Transaction), undefined, 'enforce');
    const tx = new Transaction(result.signedXdr, PASSPHRASE);
    expect(relayer.verify(tx.hash(), tx.signatures[0].signature())).toBe(true); expect(tx.hash().toString('hex')).toBe(result.transactionHash); expect(server.sendTransaction).not.toHaveBeenCalled();
  });
  it('does not sign if the deployed contract rejects the signature', async () => {
    const server = serverMock(); server.simulateTransaction.mockResolvedValue({ error: 'contract authorization failed', latestLedger: 100 } as never);
    await expect(new StellarChain(server as unknown as rpc.Server, relayer).authorize(wallet, intent, prepared(), signedAuth().toXDR('base64'))).rejects.toThrow('CONTRACT_AUTHORIZATION'); expect(server.sendTransaction).not.toHaveBeenCalled();
  });
  it('rejects mainnet RPC and excessive fees', async () => {
    const server = serverMock(); server.getNetwork.mockResolvedValueOnce({ passphrase: 'Public Global Stellar Network ; September 2015' });
    const chain = new StellarChain(server as unknown as rpc.Server, relayer);
    await expect(chain.authorize(wallet, intent, prepared(), signedAuth().toXDR('base64'))).rejects.toThrow('RPC_NETWORK_MISMATCH');
    await expect(chain.authorize(wallet, { ...intent, maxFeeStroops: '1' }, prepared(), signedAuth().toXDR('base64'))).rejects.toThrow('FEE_CAP_EXCEEDED');
  });
  it('prepares an authorization challenge without any signing or broadcast', async () => {
    const server = serverMock(); server.simulateTransaction.mockResolvedValueOnce({ id: 'balance', _parsed: true, latestLedger: 100, events: [], minResourceFee: '0', transactionData: new SorobanDataBuilder(), result: { auth: [], retval: nativeToScVal(90000000n, { type: 'i128' }) } });
    const result = await new StellarChain(server as unknown as rpc.Server, relayer).prepare(wallet, intent);
    expect(result.expirationLedger).toBe(130); expect(new Transaction(result.transactionXdr, PASSPHRASE).signatures).toHaveLength(0);
    assertTransferAuthorization(xdr.SorobanAuthorizationEntry.fromXDR(result.authXdr, 'base64'), wallet, intent); expect(server.sendTransaction).not.toHaveBeenCalled();
  });
});
describe('independent confirmation and event identity', () => {
  it('accepts native events and rejects an identically shaped event from another token contract', () => {
    const hash = 'a'.repeat(64);
    expect(decodeTransfer(event(), hash, 100, 0, 1, 1)).toMatchObject({ id: `TESTNET:${hash}:0:1`, amountStroops: intent.amountStroops });
    expect(decodeTransfer(event(wallet.address), hash, 100, 0, 1, 1)).toBeUndefined();
    expect(decodeTransfer(event(NATIVE_SAC, nativeToScVal({ amount: 2n })), hash, 100, 0, 2, 1)?.amountStroops).toBe('2');
  });
  it('derives hash from Testnet envelope and uses committed event positions', () => {
    const tx = new Transaction(prepared().transactionXdr, PASSPHRASE); const hash = tx.hash().toString('hex');
    const response = { status: 'SUCCESS', txHash: hash, ledger: 100, createdAt: 1, envelopeXdr: tx.toEnvelope(), resultXdr: new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString('100'), result: xdr.TransactionResultResult.txSuccess([]), ext: new xdr.TransactionResultExt(0) }), events: { contractEventsXdr: [[event()]], transactionEventsXdr: [] } } as unknown as rpc.Api.GetTransactionResponse;
    expect(verifyOutcome(hash, response)).toMatchObject({ status: 'SUCCESS', events: [{ id: `TESTNET:${hash}:0:0` }] });
    expect(() => verifyOutcome('a'.repeat(64), response)).toThrow('TRANSACTION_HASH_MISMATCH');
  });
});

it('filters wallet events in both directions and verifies every discovered transaction',async()=>{
 const server=serverMock(),chain=new StellarChain(server as unknown as rpc.Server,relayer),tx='a'.repeat(64);
 server.getEvents.mockResolvedValue({events:[{txHash:tx}],cursor:'wallet-page'});
 const outcome=vi.spyOn(chain,'outcome').mockResolvedValue({status:'SUCCESS',transactionHash:tx,events:[]});
 expect(await chain.events(undefined,100,wallet.address)).toEqual({events:[],cursor:'wallet-page'});
 const topic=new Address(wallet.address).toScVal().toXDR('base64'),transfer=xdr.ScVal.scvSymbol('transfer').toXDR('base64');
 expect(server.getEvents).toHaveBeenCalledWith({startLedger:100,filters:[{type:'contract',contractIds:[NATIVE_SAC],topics:[[transfer,'*',topic],[transfer,'*',topic,'*'],[transfer,topic,'*'],[transfer,topic,'*','*']]}],limit:100});
 expect(outcome).toHaveBeenCalledWith(tx);outcome.mockResolvedValue({status:'NOT_FOUND'});
 await expect(chain.events('wallet-page',100,wallet.address)).rejects.toThrow('EVENT_TRANSACTION_UNVERIFIED');
 expect(server.getEvents).toHaveBeenLastCalledWith(expect.objectContaining({cursor:'wallet-page'}));
});
