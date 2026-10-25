import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const identity=vi.hoisted(()=>({sessionAccount:vi.fn(),revokeSession:vi.fn(),getCredentials:vi.fn(),db:{query:vi.fn()}}));
const registration=vi.hoisted(()=>({beginRegistration:vi.fn(),finishRegistration:vi.fn(),beginAuthentication:vi.fn(),finishAuthentication:vi.fn()}));
vi.mock('../store.js',()=>({...identity,hashToken:(value:string)=>value}));
vi.mock('../registration.js',()=>registration);
import { buildApp } from '../app.js';
import { getConfig } from '../config.js';
import type { AutomaticDeploymentService } from './automatic-deployment.js';

const owner='11111111-1111-4111-8111-111111111111';
const config=getConfig({WALLET_ORIGIN:'https://wallet.example'});
const url='/api/v1/smart-account/deployment';
const headers={authorization:'Bearer good-session',origin:config.origin};
const pending={network:'TESTNET',status:'PENDING',address:null,onChainSignerBound:false,deploymentEnabled:true,recoveryReady:false,spendingEnabled:false};
beforeEach(()=>{
  identity.sessionAccount.mockImplementation(async(token:string)=>token==='good-session'?owner:null);
  identity.getCredentials.mockResolvedValue([]);
});
afterEach(()=>vi.resetAllMocks());
function service(){
  const stop=vi.fn(async()=>{});
  return {queue:vi.fn(async()=>pending),status:vi.fn(async()=>pending),start:vi.fn(()=>stop),stop};
}
it('queues only the verified session owner, rejects supplied authority and preserves payment gates',async()=>{
  const deployments=service();
  const app=await buildApp({config,logger:false,deployments:deployments as unknown as AutomaticDeploymentService});
  try {
    expect((await app.inject({method:'POST',url,headers:{origin:config.origin},payload:{}})).statusCode).toBe(401);
    expect((await app.inject({method:'POST',url,headers:{...headers,origin:'https://evil.example'},payload:{}})).statusCode).toBe(403);
    for(const payload of [{owner:'another-user'},{credentialId:'forged-key'},{contract_address:'forged-address'},{signedXdr:'arbitrary'}]) {
      expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(400);
    }
    expect(deployments.queue).not.toHaveBeenCalled();
    const result=await app.inject({method:'POST',url,headers,payload:{}});
    expect(result.statusCode).toBe(202);expect(result.json()).toMatchObject(pending);
    expect(deployments.queue).toHaveBeenCalledWith(owner);
    expect((await app.inject({url,headers})).json()).toMatchObject(pending);
    expect(deployments.status).toHaveBeenCalledWith(owner);
    expect((await app.inject({url:'/api/v1/wallets',headers})).statusCode).toBe(503);
    const capabilities=(await app.inject({url:'/api/v1/smart-account/capabilities'})).json();
    expect(capabilities).toMatchObject({deploymentEnabled:true,spendingEnabled:false,recoveryEnabled:false});
    expect(deployments.start).toHaveBeenCalledTimes(1);
  } finally {await app.close();}
  expect(deployments.stop).toHaveBeenCalledTimes(1);
});
it('redacts failed deployment reads and never leaks RPC or database errors',async()=>{
  const deployments=service();deployments.status.mockRejectedValue(Error('private database credentials'));
  const app=await buildApp({config,logger:false,deployments:deployments as unknown as AutomaticDeploymentService});
  try {
    const result=await app.inject({url,headers});expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({error:'DEPLOYMENT_SERVICE_UNAVAILABLE'});expect(result.body).not.toContain('private');
  } finally {await app.close();}
});
it('queues after verified registration and does not turn a queue outage into failed enrollment',async()=>{
  const deployments=service();
  registration.finishRegistration.mockResolvedValue({verified:true,accountID:owner,token:'new-session',credentialCount:1});
  const app=await buildApp({config,logger:false,deployments:deployments as unknown as AutomaticDeploymentService});
  const request={method:'POST' as const,url:'/api/v1/passkeys/registration/verify',headers:{origin:config.origin},payload:{accountID:owner,requestID:'verified-challenge',response:{}}};
  try {
    expect((await app.inject(request)).json()).toMatchObject({verified:true,accountID:owner});
    expect(deployments.queue).toHaveBeenCalledWith(owner);
    deployments.queue.mockRejectedValueOnce(Error('database unavailable'));
    expect((await app.inject(request)).json()).toMatchObject({verified:true,token:'new-session'});
    expect(identity.revokeSession).not.toHaveBeenCalled();
    registration.finishRegistration.mockRejectedValueOnce(Error('bad passkey'));
    const calls=deployments.queue.mock.calls.length;
    expect((await app.inject(request)).statusCode).toBe(400);expect(deployments.queue.mock.calls).toHaveLength(calls);
  } finally {await app.close();}
});
