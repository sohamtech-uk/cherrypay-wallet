import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionAccount: vi.fn(), getCredentials: vi.fn(), query: vi.fn(), getNetwork: vi.fn(),
}));
vi.mock('../store.js', () => ({sessionAccount:mocks.sessionAccount,getCredentials:mocks.getCredentials,db:{query:mocks.query}}));
vi.mock('./deployment-evidence.js', () => ({createTestnetRpc:()=>({getNetwork:mocks.getNetwork})}));
import { registerSmartAccountRoutes } from './routes.js';
const endpoint='/api/v1/smart-account/deployment';
const auth={authorization:'Bearer session-token'};
const pending={status:'PENDING',contract_address:null,transaction_hash:null};

describe('disabled-worker per-user provisioning reservation',()=>{
  let app:ReturnType<typeof Fastify>;
  beforeEach(async()=>{
    vi.resetAllMocks();
    mocks.sessionAccount.mockResolvedValue('owner-1');
    mocks.getCredentials.mockResolvedValue([{id:'primary'},{id:'backup'}]);
    mocks.query.mockResolvedValue({rows:[pending]});
    app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});
    await registerSmartAccountRoutes(app);
  });
  afterEach(async()=>{await app.close();vi.resetAllMocks();});
  it('rejects unauthenticated reservation and status reads without touching storage',async()=>{
    mocks.sessionAccount.mockResolvedValue(null);
    expect((await app.inject({method:'POST',url:endpoint,payload:{}})).statusCode).toBe(401);
    expect((await app.inject({url:endpoint})).statusCode).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('requires an empty JSON object and rejects caller-supplied deployment authority',async()=>{
    expect((await app.inject({method:'POST',url:endpoint,headers:auth})).statusCode).toBe(400);
    for(const payload of [{accountID:'someone-else'},{credentialId:'foreign'},{address:'unverified'},{signedXdr:'arbitrary'}]) {
      expect((await app.inject({method:'POST',url:endpoint,headers:auth,payload})).statusCode).toBe(400);
    }
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([0,1])('preserves the disabled reservation policy with %i enrolled credentials',async count=>{
    mocks.getCredentials.mockResolvedValue(Array.from({length:count},(_,i)=>({id:String(i)})));
    const result=await app.inject({method:'POST',url:endpoint,headers:auth,payload:{}});
    expect(result.statusCode).toBe(202);
    expect(result.json()).toMatchObject({status:'AWAITING_PASSKEY',deploymentEnabled:false,nextAction:'ENROLL_INDEPENDENT_BACKUP_PASSKEY'});
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('AWAITING_PASSKEY'),['owner-1']);
  });
  it('queues once at least two credentials are enrolled without claiming deployment',async()=>{
    const result=await app.inject({method:'POST',url:endpoint,headers:auth,payload:{}});
    expect(result.statusCode).toBe(202);
    expect(result.json()).toMatchObject({status:'PENDING',address:null,transactionHash:null,deploymentEnabled:false,nextAction:'AWAITING_VERIFIED_TESTNET_DEPLOYMENT_WORKER'});
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (account_id)'),['owner-1']);
  });
  it('returns stored reservation status without claiming on-chain ownership',async()=>{
    const result=await app.inject({url:endpoint,headers:auth});
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({status:'PENDING',address:null,transactionHash:null,deploymentEnabled:false});
  });
  it('returns NOT_STARTED for an account without a reservation',async()=>{
    mocks.query.mockResolvedValue({rows:[]});
    expect((await app.inject({url:endpoint,headers:auth})).json()).toEqual({status:'NOT_STARTED',deploymentEnabled:false});
  });
  it('does not expose classic G-address wallet endpoints',async()=>{
    for(const url of ['/api/v1/smart-account/classic','/api/v1/smart-account/addresses']) {
      expect((await app.inject({url,headers:auth})).statusCode).toBe(404);
    }
  });
});
