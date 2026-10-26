import { describe, expect, it, vi } from 'vitest';
import { Address, Keypair, rpc } from '@stellar/stellar-sdk';
import { PASSPHRASE, type Outcome, type TransferEvent } from '../payments/model.js';
import { FRIENDBOT_ALLOCATION_STROOPS, StellarFriendbotChain, verifyFriendbotAllocation } from './friendbot-funding.js';

const address = Address.contract(Buffer.alloc(32, 4)).toString(), source = Keypair.random().publicKey(), hash = 'a'.repeat(64);
function fixture() {
  const server = { getNetwork: vi.fn(async()=>({passphrase: String(PASSPHRASE)})), getLatestLedger: vi.fn(async()=>({sequence:200})) };
  const fetcher = vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({hash}),{status:200}));
  return {server,fetcher,chain:new StellarFriendbotChain(server as unknown as rpc.Server,vi.fn(),fetcher)};
}
describe('direct Testnet C-wallet Friendbot grant',()=>{
  it('uses a single fixed Testnet request for the C-address and treats the returned hash only as a receipt candidate',async()=>{
    const {chain,fetcher}=fixture();
    expect(await chain.latestLedger()).toBe(200);
    expect(await chain.request(address)).toBe(hash);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('https://friendbot.stellar.org/',expect.objectContaining({
      method:'POST',body:'addr='+address,redirect:'error',signal:expect.any(AbortSignal),
    }));
    expect(FRIENDBOT_ALLOCATION_STROOPS).toBe('100000000000');
  });
  it('rejects G recipients and a non-Testnet RPC before requesting funding',async()=>{
    const {chain,server,fetcher}=fixture();
    await expect(chain.request(source)).rejects.toThrow('CONTRACT_ADDRESS_REQUIRED');
    server.getNetwork.mockResolvedValue({passphrase:'mainnet'});
    await expect(chain.request(address)).rejects.toThrow('RPC_NETWORK_MISMATCH');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['timeout','rate-limit','changed-body','invalid-hash'])('never retries an uncertain %s response',async failure=>{
    const {chain,fetcher}=fixture();
    fetcher.mockImplementation(async()=>{
      if(failure==='timeout')throw Error('timeout');
      return new Response(JSON.stringify(failure==='invalid-hash'?{hash:'not-a-hash'}:{successful:true}),{status:failure==='rate-limit'?429:200});
    });
    await expect(chain.request(address)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('requires one committed 10,000 XLM receipt for this C-address after the persisted starting ledger',()=>{
    const e={from:source,to:address,amountStroops:FRIENDBOT_ALLOCATION_STROOPS,ledger:201,transactionHash:hash} as TransferEvent;
    const success=(events:TransferEvent[]):Outcome=>({status:'SUCCESS',transactionHash:hash,events});
    expect(verifyFriendbotAllocation(success([e]),hash,address,200)).toBe(201);
    for(const events of [[],[e,e],[{...e,amountStroops:'1000000000000'}],[{...e,to:source}],[{...e,from:address}],
      [{...e,transactionHash:'b'.repeat(64)}],[{...e,ledger:200}]]) {
      expect(()=>verifyFriendbotAllocation(success(events),hash,address,200)).toThrow();
    }
    expect(()=>verifyFriendbotAllocation({status:'NOT_FOUND'},hash,address,200)).toThrow();
    expect(()=>verifyFriendbotAllocation(success([e]),'b'.repeat(64),address,200)).toThrow();
  });
});
