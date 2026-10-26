import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { PaymentError } from '../payments/model.js';
import { AutomaticDeploymentService, configuredDeployments, publicDeployment } from './automatic-deployment.js';
import { StellarDeploymentChain, type DeploymentChain, type DeploymentOutcome, type PreparedDeployment } from './automatic-deployment-chain.js';
import type { DeploymentJob, DeploymentStore } from './automatic-deployment-store.js';
import { deploymentFixture } from './test-support/deployment.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture() {
  const f = deploymentFixture();
  let state: DeploymentJob = { owner:f.owner,status:'PENDING',descriptor:f.descriptor,bindingVerified:false };
  let busy = false, binding = true, loseAcknowledgement = false, counter = 0;
  const store: DeploymentStore = {
    queue: vi.fn(async () => structuredClone(state)), get: vi.fn(async () => structuredClone(state)),
    claim: vi.fn(async () => {
      if (busy || ['CONFIRMED','FAILED'].includes(state.status)) return;
      busy = true; state.leaseToken='lease-'+(++counter); return structuredClone(state);
    }),
    assertBinding: vi.fn(async () => { if (!binding) throw new PaymentError('DEPLOYMENT_LEASE_OR_CREDENTIAL_CHANGED'); }),
    checkpoint: vi.fn(async (j,p) => {
      if (j.leaseToken !== state.leaseToken) throw Error('stale lease');
      state = {...state,status:'SUBMITTED',prepared:structuredClone(p)};
      if (loseAcknowledgement) { loseAcknowledgement = false; throw Error('commit acknowledgement lost'); }
      return structuredClone(state);
    }),
    settle: vi.fn(async (_j,result) => {
      state = {...state,status:result.status,bindingVerified:result.status==='CONFIRMED',confirmedLedger:result.status==='CONFIRMED'?result.ledger:undefined,signerRuleId:result.status==='CONFIRMED'?result.signerRuleId:undefined};
      busy = false;
    }),
    retry: vi.fn(async (_j,code) => { state.failureCode=code; busy=false; }),
  };
  const prepared: PreparedDeployment = {signedXdr:'synthetic-deployment-envelope',transactionHash:'a'.repeat(64),expiresAt:Date.now()+60000};
  const chain: DeploymentChain = {
    publicKey:f.deployer.publicKey(), prepare:vi.fn(async()=>structuredClone(prepared)),
    outcome:vi.fn(async():Promise<DeploymentOutcome>=>({status:'NOT_FOUND'})), submit:vi.fn(async()=>{}),
  };
  const service=new AutomaticDeploymentService(store,chain);
  return {...f,store,chain,service,prepared,state:()=>state,loseAck:()=>{loseAcknowledgement=true;},changeBinding:()=>{binding=false;}};
}

describe('durable automatic deployment worker', () => {
  it('persists signed bytes before the first broadcast and hides an unconfirmed address', async () => {
    const f=fixture();
    vi.mocked(f.chain.submit).mockImplementation(async(_d,p)=>{
      expect(f.state()).toMatchObject({status:'SUBMITTED',prepared:p});
      expect(f.store.checkpoint).toHaveBeenCalledTimes(1);
    });
    await f.service.tick();
    expect(f.chain.submit).toHaveBeenCalledWith(f.descriptor,f.prepared);
    const status=await f.service.status(f.owner);
    expect(status).toMatchObject({status:'SUBMITTED',address:null,onChainSignerBound:false,recoveryReady:false,spendingEnabled:false});
    expect(JSON.stringify(status)).not.toContain(f.prepared.signedXdr);
  });
  it('does not broadcast after a lost commit acknowledgement and resumes exactly the stored bytes', async () => {
    const f=fixture();f.loseAck();
    await f.service.tick();expect(f.chain.submit).not.toHaveBeenCalled();expect(f.chain.outcome).not.toHaveBeenCalled();
    const restarted=new AutomaticDeploymentService(f.store,f.chain);
    await restarted.tick();
    expect(f.chain.prepare).toHaveBeenCalledTimes(1);
    expect(f.chain.submit).toHaveBeenCalledWith(f.descriptor,f.prepared);
  });
  it('queries outcome before rebroadcast and never reconstructs after an RPC send timeout', async () => {
    const f=fixture();vi.mocked(f.chain.submit).mockRejectedValueOnce(Error('timeout'));
    await f.service.tick();await f.service.tick();
    expect(f.chain.prepare).toHaveBeenCalledTimes(1);expect(f.chain.submit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.chain.submit).mock.calls.map(([,p])=>p.signedXdr)).toEqual([f.prepared.signedXdr,f.prepared.signedXdr]);
    expect(f.chain.outcome).toHaveBeenCalledTimes(2);
  });
  it('does not broadcast while outcome lookup is unavailable', async () => {
    const f=fixture();vi.mocked(f.chain.outcome).mockRejectedValue(Error('RPC unavailable'));
    await f.service.tick();expect(f.chain.submit).not.toHaveBeenCalled();
    expect(f.state().prepared).toEqual(f.prepared);expect(f.state().status).toBe('SUBMITTED');
  });
  it('keeps expired uncertain envelopes for reconciliation instead of replacing them', async () => {
    const f=fixture();f.prepared.expiresAt=Date.now()-1;
    await f.service.tick();await f.service.tick();
    expect(f.chain.prepare).toHaveBeenCalledTimes(1);expect(f.chain.submit).not.toHaveBeenCalled();
    expect(f.store.settle).not.toHaveBeenCalled();
    expect(f.state().failureCode).toBe('DEPLOYMENT_EXPIRED_OUTCOME_UNRESOLVED');
  });
  it('exposes the C-address only after independently verified confirmation, without enabling recovery or spending', async () => {
    const f=fixture();vi.mocked(f.chain.outcome).mockResolvedValue({status:'CONFIRMED',ledger:300,signerRuleId:0});
    await f.service.tick();
    expect(await f.service.status(f.owner)).toMatchObject({status:'CONFIRMED',address:f.descriptor.address,confirmedLedger:300,primaryRuleId:0,primaryCredentialId:f.credential.id,onChainSignerBound:true,recoveryReady:false,spendingEnabled:false});
    expect(f.chain.submit).not.toHaveBeenCalled();
  });
  it('never confirms a deployment whose credential changed locally', async () => {
    const f=fixture();await f.service.tick();f.changeBinding();
    vi.mocked(f.chain.outcome).mockResolvedValue({status:'CONFIRMED',ledger:300,signerRuleId:0});
    await f.service.tick();expect(f.store.settle).not.toHaveBeenCalled();expect(f.state().bindingVerified).toBe(false);
  });
  it('treats only a verified on-chain failure as a terminal failed job', async () => {
    const f=fixture();vi.mocked(f.chain.outcome).mockResolvedValue({status:'FAILED'});
    await f.service.tick();expect(f.state().status).toBe('FAILED');expect(f.chain.submit).not.toHaveBeenCalled();
  });
  it('keeps the automatic loop non-overlapping and drains in-flight work on shutdown', async () => {
    vi.useFakeTimers();const f=fixture();let finish:(()=>void)|undefined;
    const tick=vi.spyOn(f.service,'tick').mockImplementation(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const stop=f.service.start();await vi.advanceTimersByTimeAsync(20000);expect(tick).toHaveBeenCalledTimes(1);
    const draining=stop();finish!();await draining;await vi.advanceTimersByTimeAsync(20000);expect(tick).toHaveBeenCalledTimes(1);
  });
});

describe('deployment configuration', () => {
  it('defaults off and refuses malformed or missing explicit configuration', async () => {
    expect(await configuredDeployments({})).toBeUndefined();
    expect(await configuredDeployments({WALLET_DEPLOYMENTS_ENABLED:'false'})).toBeUndefined();
    await expect(configuredDeployments({WALLET_DEPLOYMENTS_ENABLED:'yes'})).rejects.toThrow('INVALID_DEPLOYMENT_ENABLE_FLAG');
    await expect(configuredDeployments({WALLET_DEPLOYMENTS_ENABLED:'true'})).rejects.toThrow('DEDICATED_DEPLOYER_CONFIGURATION_REQUIRED');
  });
  it('requires a dedicated expected deployment identity and validates limits before RPC', async () => {
    const key=Keypair.random(),other=Keypair.random();
    const env={WALLET_DEPLOYMENTS_ENABLED:'true',STELLAR_DEPLOYER_SECRET:key.secret(),STELLAR_DEPLOYER_PUBLIC_KEY:key.publicKey()};
    const preflight=vi.spyOn(StellarDeploymentChain.prototype,'preflight').mockResolvedValue();
    await expect(configuredDeployments({...env,STELLAR_DEPLOYER_PUBLIC_KEY:other.publicKey()})).rejects.toThrow('DEPLOYER_PUBLIC_KEY_MISMATCH');
    await expect(configuredDeployments({...env,STELLAR_RELAYER_SECRET:key.secret()})).rejects.toThrow('DEPLOYER_MUST_DIFFER');
    await expect(configuredDeployments({...env,WALLET_DEPLOYMENT_MAX_FEE_STROOPS:'500000001'})).rejects.toThrow('INVALID_DEPLOYMENT_FEE_CAP');
    await expect(configuredDeployments({...env,WALLET_DEPLOYMENT_PILOT_LIMIT:'-1'})).rejects.toThrow('INVALID_DEPLOYMENT_LIMIT');
    expect(preflight).not.toHaveBeenCalled();
    expect(await configuredDeployments({...env,STELLAR_RELAYER_SECRET:other.secret()})).toBeInstanceOf(AutomaticDeploymentService);
    expect(preflight).toHaveBeenCalledTimes(1);
  });
  it('does not claim a reservation or primary binding is recovered', () => {
    expect(publicDeployment()).toMatchObject({status:'NOT_STARTED',address:null,onChainSignerBound:false,recoveryReady:false,spendingEnabled:false});
  });
});
