import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MapPin, Monitor, ShieldCheck } from 'lucide-react';
import { useWalletAccount } from './account-context';
import type { AccessEntry, AccessPage } from './access-api';

function device(ua:string){const os=/Android/.test(ua)?'Android':/iPhone|iPad/.test(ua)?'iOS':/Mac/.test(ua)?'macOS':/Windows/.test(ua)?'Windows':/Linux/.test(ua)?'Linux':'Unknown device';const browser=/Edg\//.test(ua)?'Edge':/Firefox\//.test(ua)?'Firefox':/Chrome\//.test(ua)?'Chrome':/Safari\//.test(ua)?'Safari':'Browser';return `${browser} · ${os}`;}
export function AccessHistory(){
  const account=useWalletAccount();
  return <AccessHistorySession key={`${account?.accountId??''}:${account?.authenticated??false}`}/>;
}
function AccessHistorySession(){
  const account=useWalletAccount(),[page,setPage]=useState<AccessPage|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0),[selected,setSelected]=useState<AccessEntry|null>(null),[mapLoaded,setMapLoaded]=useState(false),[confirm,setConfirm]=useState<string|null>(null);
  const load=account?.listAccess;
  useEffect(()=>{let active=true;setPage(null);setSelected(null);setMapLoaded(false);setConfirm(null);setError('');if(account?.authenticated&&load){setBusy(true);void load().then(value=>{if(active)setPage(value);}).catch(()=>{if(active)setError('Unable to load access history. Try again.');}).finally(()=>{if(active)setBusy(false);});}return()=>{active=false;};},[account?.accountId,account?.authenticated,load,refresh]);
  async function revoke(id:string){setBusy(true);setError('');try{await account?.revokeAccess?.(id);if(page?.items.find(item=>item.id===id)?.current)await account?.signOut();setConfirm(null);setRefresh(n=>n+1);}catch{setError('Sign-out could not be confirmed. Refresh the session list before retrying.');}finally{setBusy(false);}}
  async function shareLocation(){
    if(!navigator.geolocation){setError('Location sharing is not supported by this browser.');return;}
    setBusy(true);setError('');
    navigator.geolocation.getCurrentPosition(position=>{
      void account?.shareLocation?.(Math.round(position.coords.latitude*10)/10,Math.round(position.coords.longitude*10)/10)
        .then(()=>setRefresh(n=>n+1)).catch(()=>setError('Your location could not be saved.')).finally(()=>setBusy(false));
    },()=>{setError('Location was not shared. You can continue using your wallet.');setBusy(false);},{enableHighAccuracy:false,timeout:10000,maximumAge:60000});
  }
  return <div className="access-page"><div className="heading"><div><span className="eyebrow">ACCOUNT SECURITY</span><h1>Access history</h1><p>Review successful sign-ins and manage active sessions.</p></div><Link className="secondary-button" to="/security"><ShieldCheck size={16}/> Security & recovery</Link></div>
    {!account?.authenticated?<section className="card"><h2>Sign in to review your access</h2><p>Your access history is only visible in your authenticated account.</p><Link className="primary-link" to="/">Sign in with a passkey</Link></section>:<>
      <section className="card"><div className="wallet-card-heading"><div><h2>Recent sign-ins</h2><p>Last 30 days · up to 100 entries. Recording begins with this release.</p></div><button className="secondary-button" disabled={busy} onClick={()=>setRefresh(n=>n+1)}>Refresh</button></div>
        {busy&&<p role="status">Updating access history…</p>}{error&&<p role="alert" className="error">{error}</p>}
        {page&&!page.items.length&&<p>No recorded sign-ins yet. Older sessions do not have history.</p>}
        <ul className="access-list">{page?.items.map(entry=><li key={entry.id}><Monitor size={22}/><div className="access-device"><strong>{device(entry.userAgent)}</strong><p><time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time> · {entry.ip??'IP unavailable'}</p><small>{entry.current?'This session':entry.active&&Date.parse(entry.expiresAt)>Date.now()?'Active session':'Ended or expired'} · {entry.location?'Approximate location shared':'Location not shared'}</small></div><div className="access-actions">{entry.location&&<button className="secondary-button" onClick={()=>{setSelected(entry);setMapLoaded(false);}}>View location</button>}{entry.active&&Date.parse(entry.expiresAt)>Date.now()&&(confirm===entry.id?<><span>Sign out this session?</span><button disabled={busy} onClick={()=>void revoke(entry.id)}>Confirm sign out</button><button className="secondary-button" onClick={()=>setConfirm(null)}>Cancel</button></>:<button className="secondary-button" disabled={busy} onClick={()=>setConfirm(entry.id)}>{entry.current?'Sign out here':'Sign out'}</button>)}</div></li>)}</ul>
        {page?.truncated&&<p>Only the most recent 100 sign-ins are shown.</p>}
        <p className="small-copy">Device details are reported by the browser. An IP may identify a network or proxy, not your physical location. Sessions expire after at most 30 minutes.</p>
      </section>
      <section className="card access-map"><MapPin size={24}/><h2>Optional location</h2><p>Share an approximate location for this session using your browser’s permission prompt. Coordinates are rounded to about city scale and kept with access history for 30 days. They are not used to approve payments.</p><button className="secondary-button" disabled={busy||!account.shareLocation} onClick={()=>void shareLocation()}>Share approximate location</button>
        {selected?.location&&<div className="location-detail"><p>Reported location: {selected.location.latitude.toFixed(1)}, {selected.location.longitude.toFixed(1)} · {new Date(selected.createdAt).toLocaleString()}</p>{page?.mapsBrowserKey?<>
          {!mapLoaded?<><p>Loading the map sends these approximate coordinates and your network request to Google Maps.</p><button className="secondary-button" onClick={()=>setMapLoaded(true)}>Load Google Map</button></>:<iframe title="Approximate location reported by this browser" loading="lazy" referrerPolicy="strict-origin-when-cross-origin" src={`https://www.google.com/maps/embed/v1/view?key=${encodeURIComponent(page.mapsBrowserKey)}&center=${selected.location.latitude},${selected.location.longitude}&zoom=10`}/>}</>:<p>Google Maps has not been configured. Your recorded coordinates remain available above.</p>}</div>}
      </section>
    </>}
  </div>;
}
