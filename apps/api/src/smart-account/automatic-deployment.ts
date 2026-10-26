import { FriendbotFundingService, StellarFriendbotChain } from './friendbot-funding.js';
import { Keypair, rpc } from '@stellar/stellar-sdk';
import { TESTNET_RPC_URL } from '../config.js';
import { PaymentError, requireThat } from '../payments/model.js';
import { StellarDeploymentChain, type DeploymentChain } from './automatic-deployment-chain.js';
import { PostgresDeploymentStore, type DeploymentJob, type DeploymentStore } from './automatic-deployment-store.js';

export function publicDeployment(j?: DeploymentJob) {
  const verified = !!j?.bindingVerified && j.status === 'CONFIRMED';
  return {
    network: 'TESTNET', status: j?.status ?? 'NOT_STARTED', deploymentEnabled: true,
    address: verified ? j!.descriptor!.address : null,
    transactionHash: j?.prepared?.transactionHash ?? null,
    confirmedLedger: verified ? j!.confirmedLedger : null,
    primaryCredentialId: verified ? j!.descriptor!.credentialId : null,
    primaryRuleId: verified ? j!.signerRuleId : null,
    onChainSignerBound: verified,
    // Creating a primary-controlled contract is NOT proof of backup recovery.
    recoveryReady: false, spendingEnabled: false,
    failureCode: j?.failureCode ?? null,
    nextAction: verified ? 'ENROLL_AND_VERIFY_INDEPENDENT_BACKUP_ONCHAIN'
      : j?.status === 'AWAITING_PASSKEY' ? 'ENROLL_PRIMARY_PASSKEY'
      : j?.status === 'FAILED' ? 'OPERATOR_REVIEW_REQUIRED' : 'WAIT_FOR_DEPLOYMENT_CONFIRMATION',
  };
}
export class AutomaticDeploymentService {
  constructor(readonly store: DeploymentStore, readonly chain: DeploymentChain, readonly funding?: FriendbotFundingService) {}
  async queue(owner: string) { await this.store.queue(owner); return this.status(owner); }
  async status(owner: string) { return {...publicDeployment(await this.store.get(owner)), ...(this.funding ? {funding:await this.funding.status(owner)} : {})}; }
  async tick(): Promise<void> {
    let current = await this.store.claim();
    if (!current) return;
    try {
      requireThat(current.descriptor, 'DEPLOYMENT_PLAN_REQUIRED');
      if (!current.prepared) {
        await this.store.assertBinding(current);
        const prepared = await this.chain.prepare(current.descriptor);
        // Lost commit acknowledgement: stop; a later worker reads the same saved bytes.
        current = await this.store.checkpoint(current, prepared);
      }
      requireThat(current.descriptor && current.prepared, 'DEPLOYMENT_CHECKPOINT_REQUIRED');
      const outcome = await this.chain.outcome(current.descriptor, current.prepared);
      if (outcome.status !== 'NOT_FOUND') {
        if (outcome.status === 'CONFIRMED') await this.store.assertBinding(current);
        await this.store.settle(current, outcome);
        return;
      }
      if (current.prepared.expiresAt <= Date.now()) {
        await this.store.retry(current, 'DEPLOYMENT_EXPIRED_OUTCOME_UNRESOLVED');
        return; // No fresh envelope/salt/sequence until uncertainty is resolved.
      }
      await this.store.assertBinding(current);
      await this.chain.submit(current.descriptor, current.prepared);
      await this.store.retry(current, 'DEPLOYMENT_AWAITING_CONFIRMATION');
    } catch (error) {
      const code = error instanceof PaymentError && /^[A-Z0-9_]{1,100}$/.test(error.code)
        ? error.code : 'DEPLOYMENT_RPC_OR_STORAGE_UNAVAILABLE';
      await this.store.retry(current, code);
    }
  }
  /** One non-overlapping loop per process, plus database fencing across processes. */
  start(onError: (code: string) => void = () => {}): () => Promise<void> {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> = Promise.resolve();
    const run = () => {
      if (stopped) return;
      running = this.tick().then(() => this.funding?.tick()).catch(() => onError('AUTOMATIC_DEPLOYMENT_WORKER_UNAVAILABLE')).finally(() => {
        if (!stopped) { timer = setTimeout(run, 5000); timer.unref?.(); }
      });
    };
    run();
    return async () => { stopped = true; clearTimeout(timer); await running; };
  }
}

export async function configuredDeployments(env: NodeJS.ProcessEnv = process.env): Promise<AutomaticDeploymentService | undefined> {
  requireThat(env.WALLET_DEPLOYMENTS_ENABLED === undefined || ['true','false'].includes(env.WALLET_DEPLOYMENTS_ENABLED), 'INVALID_DEPLOYMENT_ENABLE_FLAG');
  if (env.WALLET_DEPLOYMENTS_ENABLED !== 'true') return;
  requireThat(env.STELLAR_DEPLOYER_SECRET && env.STELLAR_DEPLOYER_PUBLIC_KEY, 'DEDICATED_DEPLOYER_CONFIGURATION_REQUIRED');
  let key: Keypair;
  try { key = Keypair.fromSecret(env.STELLAR_DEPLOYER_SECRET); }
  catch { throw Error('INVALID_DEPLOYER_SECRET'); }
  requireThat(key.publicKey() === env.STELLAR_DEPLOYER_PUBLIC_KEY, 'DEPLOYER_PUBLIC_KEY_MISMATCH');
  // Deployment and payment transaction sequences MUST NOT share a source account.
  if (env.STELLAR_RELAYER_SECRET) {
    let paymentKey: Keypair;
    try { paymentKey = Keypair.fromSecret(env.STELLAR_RELAYER_SECRET); }
    catch { throw Error('INVALID_PAYMENT_RELAYER_SECRET'); }
    requireThat(paymentKey.publicKey() !== key.publicKey(), 'DEPLOYER_MUST_DIFFER_FROM_PAYMENT_RELAYER');
  }
  const fee = env.WALLET_DEPLOYMENT_MAX_FEE_STROOPS ?? '100000000';
  requireThat(/^[1-9][0-9]{0,8}$/.test(fee) && BigInt(fee) <= 500000000n, 'INVALID_DEPLOYMENT_FEE_CAP');
  const limit = Number(env.WALLET_DEPLOYMENT_PILOT_LIMIT ?? '0');
  const store = new PostgresDeploymentStore(key.publicKey(), undefined, limit);
  const server = new rpc.Server(TESTNET_RPC_URL, { timeout: 20 });
  const chain = new StellarDeploymentChain(server, key, BigInt(fee));
  await chain.preflight();
  // Friendbot funds verified C-addresses directly; no application treasury is needed.
  requireThat(env.WALLET_TESTNET_FUNDING_ENABLED === undefined || ['true','false'].includes(env.WALLET_TESTNET_FUNDING_ENABLED), 'INVALID_FUNDING_ENABLE_FLAG');
  const funding = env.WALLET_TESTNET_FUNDING_ENABLED === 'false' ? undefined
    : new FriendbotFundingService(new StellarFriendbotChain(server, async(d,ledger)=>{await chain.verifyBinding(d,ledger);}));
  return new AutomaticDeploymentService(store, chain, funding);
}
