import { normalizeEmail } from '../store.js';
import { createHash } from 'node:crypto';
import { Address, Keypair, Operation, StrKey, Transaction, TransactionBuilder, hash, rpc, xdr } from '@stellar/stellar-sdk';
import { Client, type Signer } from 'smart-account-kit-bindings';
import { TESTNET_PASSPHRASE, TESTNET_RPC_URL } from '../config.js';
import { requireThat } from '../payments/model.js';
import { credentialKeyData } from './pinned-adapter.js';
import { TESTNET_V080 } from './kit-v080-preflight.js';
import { hashWasm } from './deployment-evidence.js';
import { verifyCurrentContractCode } from './receive-route.js';
import { readHydratedContextRule, simulationReader, withConsistentSnapshot, type RuleSpec } from './context-rules.js';

export type DeploymentDescriptor = Readonly<{
  version: 1; network: 'TESTNET'; owner: string;
  credentialId: string; credentialPublicKey: string; keyDataHex: string;
  saltHex: string; deployerPublicKey: string; address: string;
  accountWasmHash: string; verifierAddress: string; verifierWasmHash: string;
}>;
export type PreparedDeployment = { signedXdr: string; transactionHash: string; expiresAt: number };
export type DeploymentOutcome = { status: 'NOT_FOUND' } | { status: 'FAILED' } |
  { status: 'CONFIRMED'; ledger: number; signerRuleId: number };
export interface DeploymentChain {
  readonly publicKey: string;
  prepare(descriptor: DeploymentDescriptor): Promise<PreparedDeployment>;
  submit(descriptor: DeploymentDescriptor, prepared: PreparedDeployment): Promise<void>;
  outcome(descriptor: DeploymentDescriptor, prepared: PreparedDeployment): Promise<DeploymentOutcome>;
}
export type DeploymentRpc = Pick<rpc.Server, 'getNetwork' | 'getAccount' | 'getLedgerEntries' | 'simulateTransaction' | 'sendTransaction' | 'getTransaction'>;

function contractPreimage(deployer: string, salt: Buffer) {
  return xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({
    address: Address.fromString(deployer).toScAddress(), salt,
  }));
}
export function derivedDeploymentAddress(deployer: string, saltHex: string): string {
  requireThat(StrKey.isValidEd25519PublicKey(deployer) && /^[a-f0-9]{64}$/.test(saltHex), 'INVALID_DEPLOYMENT_PREIMAGE');
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({
    networkId: hash(Buffer.from(TESTNET_PASSPHRASE)), contractIdPreimage: contractPreimage(deployer, Buffer.from(saltHex, 'hex')),
  }));
  return StrKey.encodeContract(hash(preimage.toXDR()));
}
/** Takes only a credential already verified and persisted by the WebAuthn server.
 * No browser-provided signer, WASM, salt, address, constructor or envelope is accepted. */
export function deploymentDescriptor(owner: string, credential: { id: string; public_key: string }, deployer: string): DeploymentDescriptor {
  requireThat(normalizeEmail(owner) === owner && StrKey.isValidEd25519PublicKey(deployer), 'INVALID_DEPLOYMENT_OWNER');
  const keyDataHex = credentialKeyData(credential).toString('hex');
  const saltHex = createHash('sha256').update(JSON.stringify([
    'CherryPay/Testnet/deployment/v1', owner, credential.id, keyDataHex,
    TESTNET_V080.accountWasmHash, TESTNET_V080.verifierAddress,
  ])).digest('hex');
  return Object.freeze({ version: 1, network: 'TESTNET', owner, credentialId: credential.id,
    credentialPublicKey: credential.public_key, keyDataHex, saltHex, deployerPublicKey: deployer,
    address: derivedDeploymentAddress(deployer, saltHex), accountWasmHash: TESTNET_V080.accountWasmHash,
    verifierAddress: TESTNET_V080.verifierAddress, verifierWasmHash: TESTNET_V080.verifierWasmHash });
}
export function validateDeploymentDescriptor(d: DeploymentDescriptor): void {
  const expected = deploymentDescriptor(d.owner, { id: d.credentialId, public_key: d.credentialPublicKey }, d.deployerPublicKey);
  requireThat(d.version === 1 && d.network === 'TESTNET' && Object.keys(expected).every(key =>
    d[key as keyof DeploymentDescriptor] === expected[key as keyof DeploymentDescriptor]), 'DEPLOYMENT_BINDING_CHANGED');
}
/** The reviewed v0.8.0 constructor creates rule 0 with these signers and policies.
 * Exactly ONE primary passkey is installed. Adding a second signer to this rule
 * would require both signatures, not independent recovery, so we never do that. */
export function deploymentFunction(d: DeploymentDescriptor): xdr.HostFunction {
  validateDeploymentDescriptor(d);
  const signer: Signer = { tag: 'External', values: [d.verifierAddress, Buffer.from(d.keyDataHex, 'hex')] };
  const spec = new Client({ contractId: d.address, networkPassphrase: TESTNET_PASSPHRASE, rpcUrl: TESTNET_RPC_URL }).spec;
  const constructorArgs = spec.funcArgsToScVals('__constructor', { signers: [signer], policies: new Map() });
  return xdr.HostFunction.hostFunctionTypeCreateContractV2(new xdr.CreateContractArgsV2({
    contractIdPreimage: contractPreimage(d.deployerPublicKey, Buffer.from(d.saltHex, 'hex')),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(d.accountWasmHash, 'hex')), constructorArgs,
  }));
}
/** Validate the full immutable operation before signing, sending, or confirming. */
export function assertDeploymentEnvelope(tx: Transaction, d: DeploymentDescriptor): void {
  const operations = tx.toEnvelope().v1().tx().operations();
  requireThat(tx.source === d.deployerPublicKey && operations.length === 1 && !operations[0].sourceAccount(), 'DEPLOYMENT_SOURCE_OR_OPERATION_CHANGED');
  requireThat(operations[0].body().switch().name === 'invokeHostFunction', 'DEPLOYMENT_OPERATION_FORBIDDEN');
  const operation = operations[0].body().invokeHostFunctionOp();
  const expected = deploymentFunction(d);
  requireThat(operation.hostFunction().toXDR('base64') === expected.toXDR('base64'), 'DEPLOYMENT_CONSTRUCTOR_CHANGED');
  // Only native transaction-source authorization may accompany this deployment.
  requireThat(operation.auth().length === 1, 'DEPLOYMENT_AUTHORIZATION_REQUIRED');
  for (const auth of operation.auth()) {
    requireThat(auth.credentials().switch().name === 'sorobanCredentialsSourceAccount' &&
      auth.rootInvocation().subInvocations().length === 0 &&
      auth.rootInvocation().function().switch().name === 'sorobanAuthorizedFunctionTypeCreateContractV2HostFn' &&
      auth.rootInvocation().function().createContractV2HostFn().toXDR('base64') === expected.createContractV2().toXDR('base64'),
    'DEPLOYMENT_AUTHORIZATION_FORBIDDEN');
  }
}

export class StellarDeploymentChain implements DeploymentChain {
  readonly publicKey: string;
  constructor(private readonly server: DeploymentRpc, private readonly deployer: Keypair, private readonly maxFeeStroops: bigint) {
    requireThat(deployer.canSign() && maxFeeStroops > 0n && maxFeeStroops <= 500_000_000n, 'INVALID_DEPLOYMENT_FEE_CONFIGURATION');
    this.publicKey = deployer.publicKey();
  }
  private async network() {
    requireThat((await this.server.getNetwork()).passphrase === TESTNET_PASSPHRASE, 'DEPLOYMENT_TESTNET_REQUIRED');
  }
  async preflight(): Promise<void> {
    await this.network();
    await verifyCurrentContractCode(this.server, TESTNET_V080.verifierAddress, TESTNET_V080.verifierWasmHash);
    const key = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(TESTNET_V080.accountWasmHash, 'hex') }));
    const result = await this.server.getLedgerEntries(key), code = result.entries[0];
    requireThat(result.entries.length === 1 && code.key.toXDR('base64') === key.toXDR('base64') &&
      code.val.switch().name === 'contractCode' && code.liveUntilLedgerSeq && code.liveUntilLedgerSeq > result.latestLedger + 120 &&
      hashWasm(code.val.contractCode().code()) === TESTNET_V080.accountWasmHash, 'PINNED_DEPLOYMENT_WASM_UNAVAILABLE');
    await this.server.getAccount(this.publicKey); // A funded dedicated Testnet source is required.
  }
  async prepare(d: DeploymentDescriptor): Promise<PreparedDeployment> {
    requireThat(d.deployerPublicKey === this.publicKey, 'DEPLOYER_IDENTITY_CHANGED');
    await this.preflight();
    const source = await this.server.getAccount(this.publicKey);
    const func = deploymentFunction(d);
    // Enforced simulation requires explicit authorization even when the creator
    // is the transaction source. Bind it to this exact constructor and no calls.
    const auth = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(func.createContractV2()),
        subInvocations: [],
      }),
    });
    const tx = new TransactionBuilder(source, { fee: '100', networkPassphrase: TESTNET_PASSPHRASE })
      .addOperation(Operation.invokeHostFunction({ func, auth: [auth] })).setTimeout(180).build();
    const simulation = await this.server.simulateTransaction(tx, undefined, 'enforce');
    requireThat(rpc.Api.isSimulationSuccess(simulation) && !rpc.Api.isSimulationRestore(simulation) && simulation.result, 'DEPLOYMENT_SIMULATION_FAILED');
    const assembled = rpc.assembleTransaction(tx, simulation).build();
    assertDeploymentEnvelope(assembled, d);
    requireThat(assembled.signatures.length === 0 && BigInt(assembled.fee) <= this.maxFeeStroops, 'DEPLOYMENT_FEE_CAP_EXCEEDED');
    // The fee key signs the creation transaction, NEVER a user's spending auth entry.
    assembled.sign(this.deployer);
    return { signedXdr: assembled.toXDR(), transactionHash: assembled.hash().toString('hex'), expiresAt: Number(assembled.timeBounds!.maxTime) * 1000 };
  }
  private signed(d: DeploymentDescriptor, p: PreparedDeployment): Transaction {
    requireThat(d.deployerPublicKey === this.publicKey, 'DEPLOYER_IDENTITY_CHANGED');
    const tx = new Transaction(p.signedXdr, TESTNET_PASSPHRASE);
    assertDeploymentEnvelope(tx, d);
    requireThat(tx.hash().toString('hex') === p.transactionHash && tx.signatures.length === 1 &&
      this.deployer.verify(tx.hash(), tx.signatures[0].signature()) && BigInt(tx.fee) <= this.maxFeeStroops &&
      Number(tx.timeBounds?.maxTime) * 1000 === p.expiresAt, 'SIGNED_DEPLOYMENT_CHANGED');
    return tx;
  }
  async submit(d: DeploymentDescriptor, p: PreparedDeployment): Promise<void> {
    await this.network();
    const tx = this.signed(d, p);
    requireThat(p.expiresAt > Date.now(), 'DEPLOYMENT_ENVELOPE_EXPIRED');
    const response = await this.server.sendTransaction(tx);
    requireThat(response.hash === p.transactionHash, 'DEPLOYMENT_SUBMISSION_HASH_MISMATCH');
    // ERROR/TRY_AGAIN_LATER is not proof that a prior send failed. Reconcile by hash.
    requireThat(response.status === 'PENDING' || response.status === 'DUPLICATE', 'DEPLOYMENT_SUBMISSION_UNRESOLVED');
  }
  async outcome(d: DeploymentDescriptor, p: PreparedDeployment): Promise<DeploymentOutcome> {
    await this.network(); this.signed(d, p);
    const result = await this.server.getTransaction(p.transactionHash);
    if (result.status === 'NOT_FOUND') return { status: 'NOT_FOUND' };
    requireThat(result.envelopeXdr.switch().name === 'envelopeTypeTx', 'DEPLOYMENT_ENVELOPE_TYPE_CHANGED');
    const tx = new Transaction(result.envelopeXdr, TESTNET_PASSPHRASE);
    requireThat(tx.hash().toString('hex') === p.transactionHash && result.txHash === p.transactionHash, 'DEPLOYMENT_CONFIRMATION_HASH_MISMATCH');
    assertDeploymentEnvelope(tx, d);
    const success = result.resultXdr.result().switch().name === 'txSuccess';
    if (result.status === 'FAILED') { requireThat(!success, 'INCONSISTENT_DEPLOYMENT_RESULT'); return { status: 'FAILED' }; }
    requireThat(success && Number.isSafeInteger(result.ledger) && result.ledger > 0, 'DEPLOYMENT_NOT_SUCCESSFUL');
    await this.verifyBinding(d, result.ledger);
    return { status: 'CONFIRMED', ledger: result.ledger, signerRuleId: 0 };
  }
  async verifyBinding(d: DeploymentDescriptor, creationLedger: number): Promise<void> {
    validateDeploymentDescriptor(d);
    await withConsistentSnapshot(async () => {
      const [accountCode, verifierCode] = await Promise.all([
        verifyCurrentContractCode(this.server, d.address, d.accountWasmHash),
        verifyCurrentContractCode(this.server, d.verifierAddress, d.verifierWasmHash),
      ]);
      const spec = new Client({ contractId: d.address, networkPassphrase: TESTNET_PASSPHRASE, rpcUrl: TESTNET_RPC_URL }).spec as unknown as RuleSpec;
      const read = simulationReader(this.server, d.address);
      const [count, hydrated] = await Promise.all([read('get_context_rules_count', []), readHydratedContextRule(read, spec, 0)]);
      requireThat([accountCode.ledger, verifierCode.ledger, count.ledger, ...hydrated.ledgers].every(n => n === accountCode.ledger) && accountCode.ledger >= creationLedger, 'INCONSISTENT_POLICY_SNAPSHOT');
      const rule = hydrated.rule, signer = rule.signers[0];
      requireThat(spec.funcResToNative('get_context_rules_count', count.retval.toXDR('base64')) === 1 &&
        rule.id === 0 && rule.context_type.tag === 'Default' && rule.valid_until == null && rule.policies.length === 0 && rule.policy_ids.length === 0 &&
        rule.signers.length === 1 && rule.signer_ids.length === 1 && signer.tag === 'External' && signer.values[0] === d.verifierAddress &&
        Buffer.from(signer.values[1]).toString('hex') === d.keyDataHex, 'DEPLOYED_PASSKEY_BINDING_MISMATCH');
    });
  }
}
