import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it, describe } from 'vitest';
import { buildApp } from './app.js';
import { getConfig } from './config.js';
import { db,initializeStore,createAccount,createSession,sessionAccount,hashToken } from './store.js';

describe.skipIf(process.env.RUN_DB_INTEGRATION!=='1')('persisted access history',()=>{
  beforeAll(async()=>{await initializeStore();},30000);
  it('isolates owners, revokes only selected sessions and preserves audit rows without token hashes',async()=>{
    const alice=await createAccount(`${randomUUID()}@example.test`),bob=await createAccount(`${randomUUID()}@example.test`);
    const a=await createSession(alice.id,{ip:'192.0.2.1',userAgent:'Chrome/120 Mac'}),a2=await createSession(alice.id),b=await createSession(bob.id);
    const app=await buildApp({config:getConfig({WALLET_ORIGIN:'https://wallet.example',GOOGLE_MAPS_BROWSER_KEY:'public-restricted-browser-key'}),logger:false});
    const headers={authorization:`Bearer ${a.token}`,origin:'https://wallet.example'};
    try{
      expect((await app.inject('/api/v1/session/access-history')).statusCode).toBe(401);
      const list=await app.inject({url:'/api/v1/session/access-history',headers});expect(list.statusCode).toBe(200);
      const data=list.json();expect(data.items).toHaveLength(2);expect(data.items.filter((x:any)=>x.current)).toHaveLength(1);
      expect(list.body).not.toContain(a.token);expect(list.body).not.toContain(hashToken(a.token));expect(list.body).not.toContain(bob.id);
      const other=data.items.find((x:any)=>!x.current).id,current=data.items.find((x:any)=>x.current).id;
      const bList=(await app.inject({url:'/api/v1/session/access-history',headers:{authorization:`Bearer ${b.token}`}})).json();
      expect((await app.inject({method:'POST',url:`/api/v1/session/access-history/${bList.items[0].id}/revoke`,headers,payload:{}})).statusCode).toBe(404);
      expect(await sessionAccount(b.token)).toBe(bob.id);
      expect((await app.inject({method:'POST',url:`/api/v1/session/access-history/${other}/revoke`,headers:{...headers,origin:'https://evil.example'},payload:{}})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:`/api/v1/session/access-history/${other}/revoke`,headers,payload:{}})).statusCode).toBe(204);
      expect(await sessionAccount(a2.token)).toBeNull();expect(await sessionAccount(a.token)).toBe(alice.id);
      const updated=(await app.inject({url:'/api/v1/session/access-history',headers})).json();expect(updated.items.find((x:any)=>x.id===other).active).toBe(false);
      expect((await app.inject({method:'POST',url:'/api/v1/session/location',headers,payload:{latitude:51.5074,longitude:-.1278}})).statusCode).toBe(204);
      expect((await app.inject({url:'/api/v1/session/access-history',headers})).json().items.find((x:any)=>x.id===current).location).toEqual({latitude:51.5,longitude:-.1,source:'browser'});
      expect((await app.inject({method:'POST',url:'/api/v1/session/location',headers,payload:{latitude:91,longitude:0}})).statusCode).toBe(400);
      await db.query("UPDATE wallet_access_events SET created_at=NOW()-INTERVAL '31 days' WHERE id=$1",[other]);
      expect((await app.inject({url:'/api/v1/session/access-history',headers})).json().items).toHaveLength(1);
      expect((await app.inject({method:'POST',url:`/api/v1/session/access-history/${current}/revoke`,headers,payload:{}})).statusCode).toBe(204);
      expect((await app.inject({url:'/api/v1/session/access-history',headers})).statusCode).toBe(401);
    }finally{await app.close();await db.query('DELETE FROM wallet_accounts WHERE id=ANY($1)',[[alice.id,bob.id]]);}
  });
});
