import { object, type ApiClient } from './api';
export type AccessEntry={id:string;createdAt:string;expiresAt:string;ip:string|null;userAgent:string;current:boolean;active:boolean;location:{latitude:number;longitude:number;source:'browser'}|null};
export type AccessPage={items:AccessEntry[];truncated:boolean;mapsBrowserKey:string|null};
export async function readAccess(api:ApiClient):Promise<AccessPage>{
  const data=object(await api('session/access-history'));
  if(!Array.isArray(data.items)||data.items.length>100||typeof data.truncated!=='boolean'||data.mapsBrowserKey!==null&&typeof data.mapsBrowserKey!=='string')throw Error('Invalid access history');
  const items=data.items.map(value=>{
    const r=object(value);
    if(typeof r.id!=='string'||!/^[a-f0-9-]{36}$/.test(r.id)||typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt))||typeof r.expiresAt!=='string'||!Number.isFinite(Date.parse(r.expiresAt))||typeof r.current!=='boolean'||typeof r.active!=='boolean'||typeof r.userAgent!=='string'||r.userAgent.length>512||r.ip!==null&&typeof r.ip!=='string')throw Error('Invalid access event');
    if(r.location!==null){const l=object(r.location);if(typeof l.latitude!=='number'||!Number.isFinite(l.latitude)||Math.abs(l.latitude)>90||typeof l.longitude!=='number'||!Number.isFinite(l.longitude)||Math.abs(l.longitude)>180||l.source!=='browser')throw Error('Invalid access location');}
    return r as AccessEntry;
  });
  return {items,truncated:data.truncated,mapsBrowserKey:data.mapsBrowserKey as string|null};
}
