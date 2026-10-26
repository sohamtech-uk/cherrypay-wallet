import { expect, it, vi } from 'vitest';
import type { buildApp } from './app.js';
import { startServer } from './startup.js';
import { startupErrorCode } from './startup-error.js';
import { PaymentError } from './payments/model.js';
function fixture() {
  const order:string[]=[];
  const app={listen:vi.fn(async()=>{order.push('listen');return 'address';}),close:vi.fn(async()=>{order.push('close');})};
  const dependencies={initialize:vi.fn(async()=>{order.push('migrate');}),payments:vi.fn(async()=>{order.push('verify');return {};}),build:vi.fn(async()=>{order.push('build');return app as unknown as Awaited<ReturnType<typeof buildApp>>;}),closeStore:vi.fn(async()=>{order.push('closeStore');})};
  return {order,app,dependencies};
}
it('never prints SDK or database error messages, including uppercase credentials',()=>{
  expect(startupErrorCode(Error('SVERYSECRETUPPERCASEVALUE'),'FAILED')).toBe('FAILED');
  expect(startupErrorCode(Error('postgres://user:password@db'),'FAILED')).toBe('FAILED');
  expect(startupErrorCode(new PaymentError('RELAYER_IDENTITY_MISMATCH'),'FAILED')).toBe('RELAYER_IDENTITY_MISMATCH');
});
it('initializes and verifies before listening, and drains the app before closing PostgreSQL exactly once',async()=>{
  const f=fixture(), server=await startServer({},f.dependencies);
  expect(f.order).toEqual(['migrate','verify','build','listen']);
  await Promise.all([server.shutdown(),server.shutdown()]);
  expect(f.order).toEqual(['migrate','verify','build','listen','close','closeStore']);
});
it('never builds a listener when database or configured runtime checks fail',async()=>{
  for(const stage of ['initialize','payments'] as const){const f=fixture();f.dependencies[stage].mockRejectedValueOnce(Error('failure'));await expect(startServer({},f.dependencies)).rejects.toThrow('failure');expect(f.dependencies.build).not.toHaveBeenCalled();expect(f.dependencies.closeStore).toHaveBeenCalledOnce();}
});
it('does not start a listener if shutdown is requested during runtime verification',async()=>{
  const f=fixture(),controller=new AbortController();f.dependencies.payments.mockImplementation(async()=>{controller.abort();return {};});
  await expect(startServer({},f.dependencies,controller.signal)).rejects.toThrow();expect(f.dependencies.build).not.toHaveBeenCalled();expect(f.dependencies.closeStore).toHaveBeenCalledOnce();
});
it('closes application and database when listen fails and closes database even if drain fails',async()=>{
  const f=fixture();f.app.listen.mockRejectedValueOnce(Error('listen failed'));f.app.close.mockRejectedValueOnce(Error('close failed'));
  await expect(startServer({},f.dependencies)).rejects.toThrow('listen failed');expect(f.dependencies.closeStore).toHaveBeenCalledOnce();
});
