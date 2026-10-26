import { useEffect, useId, useState } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';

type Series = {prices:[number,number][];updatedAt:number;days:number;currency:'USD';asset:'XLM';source:'CoinGecko'};
export function parseMarket(value:unknown,days:number):Series {
  const data=value as Series;
  if(!data||data.days!==days||data.currency!=='USD'||data.asset!=='XLM'||data.source!=='CoinGecko'||!Array.isArray(data.prices)||data.prices.length<2||data.prices.length>3000)throw Error('Invalid market data');
  if(data.prices.some((p,i)=>!Array.isArray(p)||p.length!==2||!Number.isSafeInteger(p[0])||p[0]<=0||p[0]>Date.now()+60000||!Number.isFinite(p[1])||p[1]<=0||i>0&&p[0]<=data.prices[i-1][0])||data.updatedAt!==data.prices.at(-1)![0]||Date.now()-data.updatedAt>2*60*60*1000)throw Error('Stale or invalid market data');
  return data;
}
export function MarketChart(){
  const [days,setDays]=useState(1),[series,setSeries]=useState<Series|null>(null),[state,setState]=useState('loading'),[retry,setRetry]=useState(0);
  const [selected,setSelected]=useState<number|null>(null),chartId=useId();
  useEffect(()=>{
    const controller=new AbortController();let active=true;
    setSeries(null);setState('loading');setSelected(null);
    const timeout=setTimeout(()=>controller.abort(),12000);
    void fetch(`/api/v1/market/xlm?days=${days}`,{signal:controller.signal,credentials:'omit',redirect:'error',cache:'no-store'})
      .then(async response=>{if(!response.ok)throw Error('Unavailable');return parseMarket(await response.json(),days);})
      .then(data=>{if(active){setSeries(data);setState('ready');}})
      .catch(()=>{if(active)setState('unavailable');}).finally(()=>clearTimeout(timeout));
    return()=>{active=false;clearTimeout(timeout);controller.abort();};
  },[days,retry]);
  const prices=series?.prices??[],last=prices.at(-1)?.[1],first=prices[0]?.[1];
  const low=prices.length?Math.min(...prices.map(p=>p[1])):0,high=prices.length?Math.max(...prices.map(p=>p[1])):0;
  const span=high-low||high*.01,earliest=prices[0]?.[0]??0,latest=prices.at(-1)?.[0]??1;
  const points=prices.map(([t,p])=>`${40+(t-earliest)/(latest-earliest)*920},${220-(p-low)/span*180}`).join(' ');
  const period=days===1?'24 hours':`${days} days`;
  const change=last&&first?((last/first-1)*100):0;
  const selectedIndex=Math.min(selected??prices.length-1,prices.length-1),point=prices[selectedIndex];
  const pointX=point?40+(point[0]-earliest)/(latest-earliest)*920:0,pointY=point?220-(point[1]-low)/span*180:0;
  const priceColor=change<0?'#b7354d':'#268a6f';
  return <section className="market-chart" aria-label="XLM market reference">
    <div className="market-chart-heading"><div><span className="eyebrow">XLM · MARKET REFERENCE</span><h2>{last?`$${last.toFixed(4)} USD`:state==='loading'?'Loading XLM price…':'Price unavailable'} {last&&first?<small className={change>=0?'price-positive':'price-negative'}>{change>=0?'+':''}{change.toFixed(2)}% · {period}</small>:null}</h2><p>Real-market price only. Your Testnet XLM has no monetary value.</p></div>
      <div className="chart-ranges" aria-label="Chart period">{[[1,'1D'],[7,'1W'],[30,'1M'],[90,'3M'],[365,'1Y']].map(([value,label])=><button key={value} aria-pressed={days===value} onClick={()=>setDays(Number(value))}>{label}</button>)}</div>
    </div>
    {state==='loading'?<div className="chart-empty" role="status">Loading market reference…</div>:series?<>
      <svg className="price-chart" viewBox="0 0 1000 260" role="img" aria-label={`XLM price in USD over ${days} days. Low ${low.toFixed(4)}, high ${high.toFixed(4)}, latest ${last!.toFixed(4)}.`} onPointerMove={event=>{
        const bounds=event.currentTarget.getBoundingClientRect(),time=earliest+Math.max(0,Math.min(1,((event.clientX-bounds.left)/bounds.width*1000-40)/920))*(latest-earliest);
        setSelected(prices.reduce((best,p,i)=>Math.abs(p[0]-time)<Math.abs(prices[best][0]-time)?i:best,0));
      }}>
        <defs><linearGradient id={`${chartId}-fill`} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor={priceColor} stopOpacity=".25"/><stop offset="100%" stopColor={priceColor} stopOpacity="0"/></linearGradient></defs>
        {[40,100,160,220].map(y=><line key={y} x1="40" x2="960" y1={y} y2={y} stroke="#e2e9e7"/>)}
        <polygon points={`40,220 ${points} 960,220`} fill={`url(#${chartId}-fill)`}/><polyline points={points} fill="none" stroke={priceColor} strokeWidth="2.5"/>
        {point&&<><line x1={pointX} x2={pointX} y1="35" y2="220" stroke="#7a8b85" strokeDasharray="4 4"/><circle cx={pointX} cy={pointY} r="5" fill={priceColor}/></>}
        <text x="40" y="250">{days===1?new Date(earliest).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):new Date(earliest).toLocaleDateString()}</text><text x="960" y="250" textAnchor="end">{days===1?new Date(latest).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):new Date(latest).toLocaleDateString()}</text>
      </svg>
      {point&&<div className="chart-explorer"><label htmlFor={`${chartId}-explore`}>Explore price history</label><input id={`${chartId}-explore`} type="range" min="0" max={prices.length-1} value={selectedIndex} onChange={event=>setSelected(Number(event.target.value))} aria-valuetext={`${new Date(point[0]).toLocaleString()}: ${point[1].toFixed(4)} USD`}/><output htmlFor={`${chartId}-explore`}>{new Date(point[0]).toLocaleString()} · <strong>${point[1].toFixed(4)} USD</strong></output></div>}
      <dl className="market-stats"><div><dt>Latest price</dt><dd>${last!.toFixed(4)}</dd></div><div><dt>Change · {period}</dt><dd className={change>=0?'price-positive':'price-negative'}>{change>=0?'+':''}{change.toFixed(2)}%</dd></div><div><dt>Sampled low · {period}</dt><dd>${low.toFixed(4)}</dd></div><div><dt>Sampled high · {period}</dt><dd>${high.toFixed(4)}</dd></div></dl>
      <div className="market-meta"><span>USD market reference · sampled prices</span><span>Updated {new Date(series.updatedAt).toLocaleString()} · <a href="https://www.coingecko.com/en/coins/stellar" target="_blank" rel="noreferrer">CoinGecko ↗</a></span></div>
    </>:<div className="chart-empty"><ChartNoAxesCombined size={30}/><strong>Market data is unavailable</strong><p>Your wallet and payments are still available.</p><button className="secondary-button" onClick={()=>setRetry(v=>v+1)}>Retry market data</button></div>}
  </section>;
}
