import type { FastifyInstance } from 'fastify';

export type MarketSeries = {prices:[number,number][];updatedAt:number;currency:'USD';asset:'XLM';source:'CoinGecko';days:number};
export function marketReader(key?:string, transport:typeof fetch=fetch) {
  const cache=new Map<number,{until:number;value:MarketSeries|null;pending?:Promise<MarketSeries>}>();
  let providerRetryAt=0,rateLimits=0;
  return async(days:number):Promise<MarketSeries>=>{
    if(![1,7,30,90,365].includes(days))throw Error('MARKET_UNAVAILABLE');
    const old=cache.get(days);
    if(old?.pending)return old.pending;
    if(old&&old.until>Date.now()){if(old.value)return old.value;throw Error('MARKET_UNAVAILABLE');}
    if(providerRetryAt>Date.now())throw Error('MARKET_UNAVAILABLE');
    const entry:{until:number;value:MarketSeries|null;pending?:Promise<MarketSeries>}={until:0,value:null};
    cache.set(days,entry);
    entry.pending=(async()=>{
      try{
        const response=await transport(`https://api.coingecko.com/api/v3/coins/stellar/market_chart?vs_currency=usd&days=${days}`,{
          // CoinGecko supports keyless market charts. A configured Demo key is optional
          // and stays server-side; never send an empty authentication header.
          headers:{accept:'application/json',...(key?.trim()?{'x-cg-demo-api-key':key.trim()}:{})},redirect:'error',signal:AbortSignal.timeout(8000)});
        if(response.status===429){
          const retryAfter=response.headers.get('retry-after');
          const requested=retryAfter&&/^\d+$/.test(retryAfter)?Number(retryAfter)*1000:retryAfter?Date.parse(retryAfter)-Date.now():0;
          providerRetryAt=Date.now()+Math.min(3600000,Math.max(60000*2**Math.min(rateLimits++,4),Number.isFinite(requested)?requested:0));
          throw Error('MARKET_UNAVAILABLE');
        }
        if(!response.ok)throw Error('MARKET_UNAVAILABLE');
        const data=await response.json() as {prices?:unknown};
        const now=Date.now();
        if(!Array.isArray(data.prices)||data.prices.length<2||data.prices.length>3000)throw Error('MARKET_INVALID');
        const prices=data.prices as [number,number][];
        if(prices.some((point,i)=>!Array.isArray(point)||point.length!==2||!Number.isSafeInteger(point[0])||point[0]<=0||point[0]>now+60000||!Number.isFinite(point[1])||point[1]<=0||i>0&&point[0]<=prices[i-1][0]))throw Error('MARKET_INVALID');
        const updatedAt=prices.at(-1)![0];
        if(now-updatedAt>2*60*60*1000)throw Error('MARKET_STALE');
        rateLimits=0;
        entry.value={prices,updatedAt,currency:'USD',asset:'XLM',source:'CoinGecko',days};entry.until=now+5*60000;
        return entry.value;
      }catch{entry.until=Date.now()+60000;throw Error('MARKET_UNAVAILABLE');}
      finally{entry.pending=undefined;}
    })();
    return entry.pending;
  };
}
export async function registerMarket(app:FastifyInstance,key?:string){
  const read=marketReader(key);
  app.get('/api/v1/market/xlm',{schema:{querystring:{type:'object',additionalProperties:false,properties:{days:{type:'string',enum:['1','7','30','90','365']}}}}},async(req,reply)=>{
    try{return await read(Number((req.query as {days?:string}).days??1));}
    catch{return reply.code(503).send({error:'MARKET_UNAVAILABLE'});}
  });
}
