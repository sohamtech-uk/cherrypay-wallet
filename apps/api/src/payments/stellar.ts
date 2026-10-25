import { Address, Contract, Keypair, Operation, rpc, scValToNative, nativeToScVal, StrKey, Transaction, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { amount, NATIVE_SAC, NETWORK, PASSPHRASE, PaymentError, requireThat, validateIntent, type Chain, type Intent, type Outcome, type Prepared, type TransferEvent, type Wallet } from './model.js';

/** V1 and CAP-71 V2 are supported; delegated/source-account authorization is not. */
export function addressCredentials(credentials: xdr.SorobanCredentials) {
  if (credentials.switch().name === 'sorobanCredentialsAddress') return credentials.address();
  if (credentials.switch().name === 'sorobanCredentialsAddressV2') return credentials.addressV2();
  throw new PaymentError('SOURCE_ACCOUNT_OR_DELEGATED_AUTH_FORBIDDEN');
}
export function transferOperation(from: string, to: string, stroops: string) {
  amount(stroops);
  return new Contract(NATIVE_SAC).call('transfer', new Address(from).toScVal(), new Address(to).toScVal(), nativeToScVal(BigInt(stroops), { type: 'i128' }));
}
export function assertTransferAuthorization(auth: xdr.SorobanAuthorizationEntry, wallet: Wallet, intent: Intent) {
  const credentials = auth.credentials();
  addressCredentials(credentials);
  requireThat(Address.fromScAddress(addressCredentials(credentials).address()).toString() === wallet.address, 'AUTH_ADDRESS_MISMATCH');
  const invocation = auth.rootInvocation();
  requireThat(invocation.subInvocations().length === 0, 'NESTED_AUTH_FORBIDDEN');
  requireThat(invocation.function().switch().name === 'sorobanAuthorizedFunctionTypeContractFn', 'AUTH_FUNCTION_FORBIDDEN');
  const expected = transferOperation(wallet.address, intent.destination, intent.amountStroops).body().invokeHostFunctionOp().hostFunction().invokeContract();
  requireThat(invocation.function().contractFn().toXDR('base64') === expected.toXDR('base64'), 'AUTH_INTENT_MISMATCH');
}
export function bindAuthorization(wallet: Wallet, intent: Intent, prepared: Prepared, signedAuthXdr: string): Transaction {
  let auth: xdr.SorobanAuthorizationEntry;
  try { auth = xdr.SorobanAuthorizationEntry.fromXDR(signedAuthXdr, 'base64'); }
  catch { throw new PaymentError('INVALID_AUTH_XDR', 400); }
  assertTransferAuthorization(auth, wallet, intent);
  requireThat(addressCredentials(auth.credentials()).signature().switch().name !== 'scvVoid', 'SIGNATURE_REQUIRED', 400);
  const unsigned = xdr.SorobanAuthorizationEntry.fromXDR(auth.toXDR('base64'), 'base64');
  addressCredentials(unsigned.credentials()).signature(xdr.ScVal.scvVoid());
  requireThat(unsigned.toXDR('base64') === prepared.authXdr, 'AUTH_NONCE_EXPIRY_OR_INVOCATION_CHANGED', 400);
  const envelope = xdr.TransactionEnvelope.fromXDR(prepared.transactionXdr, 'base64');
  requireThat(envelope.switch().name === 'envelopeTypeTx', 'INVALID_PREPARED_ENVELOPE');
  const operations = envelope.v1().tx().operations();
  requireThat(operations.length === 1 && !operations[0].sourceAccount() && operations[0].body().switch().name === 'invokeHostFunction', 'PREPARED_OPERATION_FORBIDDEN');
  const operation = operations[0].body().invokeHostFunctionOp();
  const expected = transferOperation(wallet.address, intent.destination, intent.amountStroops).body().invokeHostFunctionOp();
  requireThat(operation.hostFunction().toXDR('base64') === expected.hostFunction().toXDR('base64'), 'PREPARED_INTENT_MISMATCH');
  operation.auth([auth]);
  return new Transaction(envelope, PASSPHRASE);
}
export function decodeTransfer(event: xdr.ContractEvent, hash: string, ledger: number, operationIndex: number, eventIndex: number, closedAt: number): TransferEvent | undefined {
  const contractId = event.contractId();
  if (event.type().name !== 'contract' || !Buffer.isBuffer(contractId) || StrKey.encodeContract(contractId) !== NATIVE_SAC || event.body().switch() !== 0) return;
  const body = event.body().v0(); const topics = body.topics();
  if (topics.length < 3 || topics.length > 4 || topics[0].switch().name !== 'scvSymbol' || topics[0].sym().toString() !== 'transfer') return;
  if (topics[1].switch().name !== 'scvAddress' || topics[2].switch().name !== 'scvAddress') return;
  if (topics.length === 4 && scValToNative(topics[3]) !== 'native') return;
  const raw = scValToNative(body.data()); const value = typeof raw === 'bigint' ? raw : raw?.amount;
  requireThat(typeof value === 'bigint' && value > 0n && value <= 9223372036854775807n, 'INVALID_TRANSFER_EVENT');
  return { id: `${NETWORK}:${hash}:${operationIndex}:${eventIndex}`, transactionHash: hash, ledger, operationIndex, eventIndex,
    from: Address.fromScVal(topics[1]).toString(), to: Address.fromScVal(topics[2]).toString(), amountStroops: value.toString(), closedAt };
}
export function verifyOutcome(hash: string, response: rpc.Api.GetTransactionResponse): Outcome {
  requireThat(/^[a-f0-9]{64}$/.test(hash), 'INVALID_TRANSACTION_HASH');
  if (response.status === 'NOT_FOUND') return { status: 'NOT_FOUND' };
  const tx = TransactionBuilder.fromXDR(response.envelopeXdr, PASSPHRASE);
  requireThat(tx.hash().toString('hex') === hash && response.txHash === hash, 'TRANSACTION_HASH_MISMATCH');
  const result = response.resultXdr.result().switch().name;
  if (response.status === 'FAILED') {
    requireThat(result !== 'txSuccess' && result !== 'txFeeBumpInnerSuccess', 'INCONSISTENT_TRANSACTION_RESULT');
    return { status: 'FAILED', transactionHash: hash };
  }
  requireThat(result === 'txSuccess' || result === 'txFeeBumpInnerSuccess', 'TRANSACTION_NOT_SUCCESSFUL');
  requireThat(Number.isSafeInteger(response.ledger) && response.ledger > 0, 'INVALID_CONFIRMATION_LEDGER');
  let groups = response.events?.contractEventsXdr ?? [];
  // Protocol <=22 metadata has a single Soroban invocation per transaction.
  if (!groups.length && response.resultMetaXdr.switch() === 3) groups = [response.resultMetaXdr.v3().sorobanMeta()?.events() ?? []];
  const events = groups.flatMap((group, op) => group.flatMap((event, index) => {
    const decoded = decodeTransfer(event, hash, response.ledger, op, index, response.createdAt * 1000);
    return decoded ? [decoded] : [];
  }));
  return { status: 'SUCCESS', transactionHash: hash, events };
}

/** Native XLM SAC only. A dedicated fee-paying G-account never signs on behalf of the C-account. */
export class StellarChain implements Chain {
  constructor(readonly server: rpc.Server, private readonly relayer: Keypair) {
    requireThat(relayer.canSign(), 'RELAYER_SIGNER_REQUIRED');
  }
  private async network() { requireThat((await this.server.getNetwork()).passphrase === PASSPHRASE, 'RPC_NETWORK_MISMATCH'); }
  async balance(address: string) {
    await this.network();
    const account = await this.server.getAccount(this.relayer.publicKey());
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: PASSPHRASE }).addOperation(new Contract(NATIVE_SAC).call('balance', new Address(address).toScVal())).setTimeout(30).build();
    const result = await this.server.simulateTransaction(tx, undefined, 'enforce');
    if (!rpc.Api.isSimulationSuccess(result) || rpc.Api.isSimulationRestore(result) || !result.result) throw new Error('BALANCE_UNAVAILABLE');
    const value = scValToNative(result.result.retval);
    requireThat(typeof value === 'bigint' && value >= 0n, 'INVALID_BALANCE');
    return { amountStroops: value.toString(), ledger: result.latestLedger };
  }
  async prepare(wallet: Wallet, intent: Intent): Promise<Prepared> {
    validateIntent(intent, wallet); requireThat(amount(intent.maxFeeStroops) <= 10000000n, 'SPONSOR_FEE_LIMIT', 400); await this.network();
    const balance = await this.balance(wallet.address);
    requireThat(BigInt(balance.amountStroops) >= amount(intent.amountStroops), 'INSUFFICIENT_BALANCE');
    const account = await this.server.getAccount(this.relayer.publicKey());
    const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: PASSPHRASE }).addOperation(transferOperation(wallet.address, intent.destination, intent.amountStroops)).setTimeout(120).build();
    const simulation = await this.server.simulateTransaction(tx, undefined, 'record');
    if (!rpc.Api.isSimulationSuccess(simulation) || rpc.Api.isSimulationRestore(simulation) || !simulation.result) throw new Error('TRANSFER_SIMULATION_UNAVAILABLE');
    requireThat(simulation.result.auth.length === 1, 'UNEXPECTED_AUTHORIZATION_COUNT');
    const auth = simulation.result.auth[0]; assertTransferAuthorization(auth, wallet, intent);
    const expirationLedger = simulation.latestLedger + 30;
    addressCredentials(auth.credentials()).signatureExpirationLedger(expirationLedger);
    addressCredentials(auth.credentials()).signature(xdr.ScVal.scvVoid());
    const assembled = rpc.assembleTransaction(tx, simulation).build();
    requireThat(BigInt(assembled.fee) <= amount(intent.maxFeeStroops), 'FEE_CAP_EXCEEDED');
    return { transactionXdr: assembled.toXDR(), authXdr: auth.toXDR('base64'), feeStroops: intent.maxFeeStroops,
      expiresAt: Number(assembled.timeBounds!.maxTime) * 1000, expirationLedger, ledger: simulation.latestLedger };
  }
  async authorize(wallet: Wallet, intent: Intent, prepared: Prepared, authXdr: string) {
    await this.network(); requireThat(prepared.expiresAt > Date.now(), 'QUOTE_EXPIRED');
    const tx = bindAuthorization(wallet, intent, prepared, authXdr);
    requireThat(tx.source === this.relayer.publicKey() && tx.signatures.length === 0 && tx.operations.length === 1, 'PREPARED_TRANSACTION_MISMATCH');
    // Enforce runs the deployed contract's __check_auth; a passkey login assertion cannot replace this.
    const simulation = await this.server.simulateTransaction(tx, undefined, 'enforce');
    if (!rpc.Api.isSimulationSuccess(simulation) || rpc.Api.isSimulationRestore(simulation)) throw new PaymentError('CONTRACT_AUTHORIZATION_OR_EXECUTION_REJECTED');
    requireThat(simulation.latestLedger < prepared.expirationLedger, 'AUTH_EXPIRED');
    const assembled = rpc.assembleTransaction(tx, simulation).build();
    requireThat(BigInt(assembled.fee) <= amount(intent.maxFeeStroops), 'FEE_CAP_EXCEEDED');
    // Assembly must preserve the supplied authorization, never replace it with recording-mode output.
    const finalAuth = assembled.toEnvelope().v1().tx().operations()[0].body().invokeHostFunctionOp().auth();
    requireThat(finalAuth.length === 1 && finalAuth[0].toXDR('base64') === authXdr, 'ASSEMBLED_AUTH_CHANGED');
    assembled.sign(this.relayer);
    return { signedXdr: assembled.toXDR(), transactionHash: assembled.hash().toString('hex') };
  }
  async submit(signedXdr: string) {
    await this.network();
    const tx = new Transaction(signedXdr, PASSPHRASE);
    const result = await this.server.sendTransaction(tx);
    requireThat(result.hash === tx.hash().toString('hex'), 'SUBMISSION_HASH_MISMATCH');
    // Even ERROR/TRY_AGAIN_LATER may follow an earlier successful broadcast. Only getTransaction can settle failure.
    if (result.status !== 'PENDING' && result.status !== 'DUPLICATE') throw new Error('SUBMISSION_UNCERTAIN');
  }
  async outcome(hash: string) { await this.network(); return verifyOutcome(hash, await this.server.getTransaction(hash)); }
  async events(cursor: string | undefined, startLedger: number) {
    await this.network();
    const result = await this.server.getEvents({ ...(cursor ? { cursor } : { startLedger }), filters: [{ type: 'contract', contractIds: [NATIVE_SAC] }], limit: 100 });
    requireThat(typeof result.cursor === 'string' && result.cursor.length > 0, 'INVALID_MONITOR_CURSOR');
    // getEvents is discovery only. Verify each transaction and derive event IDs from the committed event positions.
    const events: TransferEvent[] = [];
    for (const hash of new Set(result.events.map(e => e.txHash))) {
      const outcome = await this.outcome(hash);
      requireThat(outcome.status === 'SUCCESS', 'EVENT_TRANSACTION_UNVERIFIED');
      events.push(...outcome.events);
    }
    return { events, cursor: result.cursor };
  }
}

