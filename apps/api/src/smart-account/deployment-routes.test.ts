import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessionAccount: vi.fn(),
  getCredentials: vi.fn(),
  query: vi.fn(),
  getNetwork: vi.fn(),
}));
vi.mock('../store.js', () => ({
  sessionAccount: mocks.sessionAccount,
  getCredentials: mocks.getCredentials,
  db: { query: mocks.query },
}));
vi.mock('./deployment-evidence.js', () => ({
  createTestnetRpc: () => ({ getNetwork: mocks.getNetwork }),
}));
import { registerSmartAccountRoutes } from './routes.js';

const endpoint = '/api/v1/smart-account/deployment';
const auth = { authorization: 'Bearer session-token' };
const pending = { status: 'PENDING', contract_address: null, transaction_hash: null };

describe('per-user C-address provisioning reservation', () => {
  let app: ReturnType<typeof Fastify>;
  beforeEach(async () => {
    vi.resetAllMocks();
    mocks.sessionAccount.mockResolvedValue('owner-1');
    mocks.getCredentials.mockResolvedValue([{ id: 'primary' }, { id: 'backup' }]);
    mocks.query.mockResolvedValue({ rows: [pending] });
    app = Fastify();
    await registerSmartAccountRoutes(app);
  });
  afterEach(async () => { await app.close(); vi.resetAllMocks(); });

  it('rejects unauthenticated reservation and status reads without touching storage', async () => {
    mocks.sessionAccount.mockResolvedValue(null);
    expect((await app.inject({ method: 'POST', payload: {}, url: endpoint })).statusCode).toBe(401);
    expect((await app.inject({ url: endpoint })).statusCode).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each([0, 1])('requires backup enrollment with %i registered credentials', async count => {
    mocks.getCredentials.mockResolvedValue(Array.from({ length: count }, (_, i) => ({ id: String(i) })));
    const response = await app.inject({ method: 'POST', payload: {}, url: endpoint, headers: auth });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: 'AWAITING_PASSKEY', deploymentEnabled: false,
      nextAction: 'ENROLL_INDEPENDENT_BACKUP_PASSKEY',
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('AWAITING_PASSKEY'), ['owner-1'],
    );
  });

  it('queues once at least two credentials are enrolled without claiming deployment', async () => {
    const response = await app.inject({ method: 'POST', payload: {}, url: endpoint, headers: auth });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      status: 'PENDING', address: null, transactionHash: null,
      deploymentEnabled: false, nextAction: 'AWAITING_VERIFIED_TESTNET_DEPLOYMENT_WORKER',
    });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (account_id)'), ['owner-1']);
  });

  it('returns the stored deployment status without treating a reservation as an on-chain wallet', async () => {
    const response = await app.inject({ url: endpoint, headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'PENDING', address: null, transactionHash: null, deploymentEnabled: false });
  });

  it('returns NOT_STARTED for an account without a deployment reservation', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    expect((await app.inject({ url: endpoint, headers: auth })).json()).toEqual({ status: 'NOT_STARTED', deploymentEnabled: false });
  });

  it('does not expose classic G-address wallet endpoints', async () => {
    for (const url of ['/api/v1/smart-account/classic', '/api/v1/smart-account/addresses']) {
      expect((await app.inject({ url, headers: auth })).statusCode).toBe(404);
    }
  });
});

it('funding requires an authenticated session and cannot take a caller-supplied owner, amount or address',async()=>{
  const queue=vi.fn(async()=>({status:'PENDING',amountStroops:'100000000000'}));
  const app=Fastify({ajv:{customOptions:{removeAdditional:false}}});
  const {AutomaticDeploymentService}=await import('./automatic-deployment.js');
  await registerSmartAccountRoutes(app,{origin:'http://localhost',deployments:{funding:{queue}} as unknown as InstanceType<typeof AutomaticDeploymentService>});
  const url='/api/v1/smart-account/funding',headers={...auth,origin:'http://localhost'};
  mocks.sessionAccount.mockResolvedValue(null);
  expect((await app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(401);
  mocks.sessionAccount.mockResolvedValue('owner-1');
  expect((await app.inject({method:'POST',url,headers:{...headers,origin:'http://foreign'},payload:{}})).statusCode).toBe(403);
  for(const payload of [{owner:'foreign'},{address:'foreign'},{amountStroops:'1'}])expect((await app.inject({method:'POST',url,headers,payload})).statusCode).toBe(400);
  expect(queue).not.toHaveBeenCalled();
  expect((await app.inject({method:'POST',url,headers,payload:{}})).statusCode).toBe(202);
  expect(queue).toHaveBeenCalledWith('owner-1');await app.close();
});
