import {beforeEach,expect,it,vi} from 'vitest';
import {MemoryRepository} from './test-support/memory-repository.js';
import {PaymentService} from './service.js';
import {wallet,intent,mockChain,mockPolicy} from './test-fixtures.js';
let store:MemoryRepository,chain:ReturnType<typeof mockChain>,service:PaymentService;
const key='safe-reset-payment-key';
beforeEach(()=>{store=new MemoryRepository();store.register(wallet);chain=mockChain();service=new PaymentService(store,chain,mockPolicy(),1);});
it('blocks a late create before allowing a missing payment to reset',async()=>{
 expect(await service.reset(wallet.owner,wallet.id,key)).toEqual({reset:true,outcome:'not_created'});
 await expect(service.create(wallet.owner,wallet.id,intent,key)).rejects.toThrow('PAYMENT_PREPARATION_RESET');
 expect(chain.prepare).not.toHaveBeenCalled();expect(chain.submit).not.toHaveBeenCalled();
 expect((await service.create(wallet.owner,wallet.id,intent,key+'-new')).status).toBe('awaiting_approval');
});
it('cancels an unsigned attempt and keeps its audit record',async()=>{
 const a=await service.create(wallet.owner,wallet.id,intent,key);
 expect(await service.reset(wallet.owner,wallet.id,key)).toMatchObject({reset:true,outcome:'cancelled',attempt:{id:a.id,status:'rejected',failureCode:'USER_CANCELLED'}});
 expect(await store.get(a.id)).toMatchObject({status:'rejected'});expect(chain.submit).not.toHaveBeenCalled();
 expect(await service.reset(wallet.owner,wallet.id,key)).toMatchObject({reset:true,outcome:'rejected'});
});
it('preserves signed unknown outcomes and their relayer reservation',async()=>{
 const a=await service.create(wallet.owner,wallet.id,intent,key);vi.mocked(chain.submit).mockRejectedValueOnce(Error('Timeout after broadcast'));
 await service.approve(wallet.owner,wallet.id,a.id,'auth');const before=await store.get(a.id);
 await expect(service.reset(wallet.owner,wallet.id,key)).rejects.toThrow('CANNOT_CANCEL_SUBMITTED_ATTEMPT');
 expect(await store.get(a.id)).toEqual(before);await expect(service.create(wallet.owner,wallet.id,intent,key+'-new')).rejects.toThrow('RELAYER_BUSY');
});
it('refuses reset while an authorization lease is active and enforces ownership',async()=>{
 const a=await service.create(wallet.owner,wallet.id,intent,key);await store.claim(a.id,['awaiting_approval']);
 await expect(service.reset(wallet.owner,wallet.id,key)).rejects.toThrow('ATTEMPT_BUSY_OR_INVALID_STATE');
 await expect(service.reset('other',wallet.id,key)).rejects.toThrow('WALLET_NOT_FOUND');
 expect((await store.get(a.id)).status).toBe('awaiting_approval');
});
