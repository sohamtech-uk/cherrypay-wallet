import { expect, it, vi } from 'vitest';
import { initializeStoreWithRetry } from './database-startup.js';
it('preserves bounded retries for transient PostgreSQL availability failures',async()=>{
  const initialize=vi.fn<()=>Promise<void>>().mockRejectedValueOnce(Object.assign(Error('private detail'),{code:'ECONNREFUSED'})).mockRejectedValueOnce(Object.assign(Error('startup'),{code:'57P03'})).mockResolvedValue();
  const wait=vi.fn(async()=>{}),warn=vi.fn();
  await initializeStoreWithRetry(initialize,{wait,warn});
  expect(initialize).toHaveBeenCalledTimes(3);expect(wait).toHaveBeenCalledTimes(2);expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
});
it('does not retry schema/authentication errors and stops after 30 transient failures',async()=>{
  const wait=vi.fn(async()=>{}),warn=vi.fn();
  const permanent=vi.fn(async()=>{throw Object.assign(Error('migration failed'),{code:'23505'});});
  await expect(initializeStoreWithRetry(permanent,{wait,warn})).rejects.toThrow('migration failed');expect(permanent).toHaveBeenCalledOnce();expect(wait).not.toHaveBeenCalled();
  const unavailable=vi.fn(async()=>{throw Object.assign(Error('unavailable'),{code:'ECONNRESET'});});
  await expect(initializeStoreWithRetry(unavailable,{wait,warn})).rejects.toThrow('unavailable');expect(unavailable).toHaveBeenCalledTimes(30);expect(wait).toHaveBeenCalledTimes(29);
});
it('cancels retry on shutdown without leaking an unknown error code',async()=>{
  const controller=new AbortController(),warn=vi.fn(),initialize=vi.fn(async()=>{throw Object.assign(Error('Connection terminated'),{code:'private-secret'});});
  await expect(initializeStoreWithRetry(initialize,{signal:controller.signal,warn,wait:async()=>{controller.abort();}})).rejects.toThrow();
  expect(initialize).toHaveBeenCalledOnce();expect(warn).toHaveBeenCalledWith({code:'DB_CONNECTION_UNAVAILABLE',attempt:1});
});
