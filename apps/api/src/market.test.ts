import { afterEach, expect, it, vi } from 'vitest';
import { marketReader } from './market.js';
afterEach(()=>vi.useRealTimers());
it.each([undefined,'','   '])('loads public market data without a configured key (%s)',async key=>{
  const now=Date.now(),fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({prices:[[now-86400000,.1],[now,.2]]})));
  const read=marketReader(key,fetcher);
  expect((await read(1)).source).toBe('CoinGecko');
  expect(fetcher.mock.calls[0][1]?.headers).toEqual({accept:'application/json'});
  await read(1);expect(fetcher).toHaveBeenCalledTimes(1);
});
it('validates, coalesces and caches a market series without disclosing its key',async()=>{
  const now=Date.now(),fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({prices:[[now-86400000,.1],[now,.2]]})));
  const read=marketReader('server-only-key',fetcher);
  const [first,second]=await Promise.all([read(1),read(1)]);
  expect(first).toEqual(second);expect(first.prices).toHaveLength(2);expect(JSON.stringify(first)).not.toContain('server-only-key');
  expect(await read(1)).toEqual(first);expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe('https://api.coingecko.com/api/v3/coins/stellar/market_chart?vs_currency=usd&days=1');
  expect(fetcher.mock.calls[0][1]?.headers).toEqual({accept:'application/json','x-cg-demo-api-key':'server-only-key'});
  await expect(read(2)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
});
it('respects rate limits across chart periods and recovers after Retry-After',async()=>{
  vi.useFakeTimers();const now=Date.now();
  const fetcher=vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('{}',{status:429,headers:{'retry-after':'120'}}))
    .mockResolvedValueOnce(new Response(JSON.stringify({prices:[[now-7*86400000,.1],[now,.2]]})));
  const read=marketReader(undefined,fetcher);
  await expect(read(1)).rejects.toThrow('MARKET_UNAVAILABLE');
  await expect(read(7)).rejects.toThrow('MARKET_UNAVAILABLE');
  vi.advanceTimersByTime(60001);await expect(read(7)).rejects.toThrow('MARKET_UNAVAILABLE');
  expect(fetcher).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60000);expect((await read(7)).days).toBe(7);expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each(['stale','negative','unordered','empty','provider-error'])('rejects %s data and backs off retries',async mode=>{
  vi.useFakeTimers();const now=Date.now();
  const prices=mode==='stale'?[[now-3*3600000,.1],[now-2.5*3600000,.2]]:mode==='negative'?[[now-1000,.1],[now,-1]]:mode==='unordered'?[[now,.1],[now-1000,.2]]:[];
  const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({prices}),{status:mode==='provider-error'?429:200}));const read=marketReader('key',fetcher);
  await expect(read(1)).rejects.toThrow('MARKET_UNAVAILABLE');await expect(read(1)).rejects.toThrow('MARKET_UNAVAILABLE');expect(fetcher).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60001);await expect(read(1)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(2);
});
