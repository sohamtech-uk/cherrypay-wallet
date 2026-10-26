import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

export async function registerAccessHistory(app: FastifyInstance, deps: {
  pool: Pool; authenticate(token: string | undefined): Promise<string | null>; hash(token: string): string;
  mapsBrowserKey?: string;
}) {
  let retention:ReturnType<typeof setInterval>|undefined;
  const clean=async()=>{try{await deps.pool.query("DELETE FROM wallet_access_events WHERE created_at<NOW()-INTERVAL '30 days'");}catch{app.log.warn({code:'ACCESS_HISTORY_RETENTION_RETRY'},'Access history cleanup will retry');}};
  app.addHook('onReady',async()=>{await clean();retention=setInterval(()=>void clean(),60*60*1000);retention.unref();});
  app.addHook('onClose',async()=>{clearInterval(retention);});
  const token = (header?: string) => header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  app.get('/api/v1/session/access-history', async (req, reply) => {
    try {
      const t = token(req.headers.authorization), owner = await deps.authenticate(t);
      if (!owner || !t) return reply.code(401).send({error: 'AUTHENTICATION_REQUIRED'});
      const {rows} = await deps.pool.query(`SELECT id,created_at,expires_at,ip_address,user_agent,latitude,longitude,
        session_hash=$2 AS current,session_hash IS NOT NULL AND expires_at>NOW() AS active
        FROM wallet_access_events WHERE account_id=$1 AND created_at>NOW()-INTERVAL '30 days'
        ORDER BY created_at DESC,id DESC LIMIT 101`, [owner, deps.hash(t)]);
      return {items: rows.slice(0,100).map(r => ({id:r.id,createdAt:r.created_at.toISOString(),expiresAt:r.expires_at.toISOString(),
        ip:r.ip_address, userAgent:r.user_agent,current:!!r.current,active:r.active,
        location:r.latitude === null ? null : {latitude:Number(r.latitude),longitude:Number(r.longitude),source:'browser' as const}})),
        truncated:rows.length>100,mapsBrowserKey:deps.mapsBrowserKey || null};
    } catch { return reply.code(503).send({error:'ACCESS_HISTORY_UNAVAILABLE'}); }
  });
  app.post('/api/v1/session/access-history/:id/revoke', {schema:{params:{type:'object',required:['id'],properties:{id:{type:'string',pattern:'^[a-f0-9-]{36}$'}}}}}, async (req, reply) => {
    try {
      const t=token(req.headers.authorization),owner=await deps.authenticate(t);
      if (!owner) return reply.code(401).send({error:'AUTHENTICATION_REQUIRED'});
      const {id}=req.params as {id:string};
      const result = await deps.pool.query(`DELETE FROM wallet_sessions WHERE token_hash IN
        (SELECT session_hash FROM wallet_access_events WHERE account_id=$1 AND id=$2) RETURNING token_hash`,[owner,id]);
      if (!result.rowCount) return reply.code(404).send({error:'SESSION_NOT_ACTIVE'});
      return reply.code(204).send();
    } catch {return reply.code(503).send({error:'SESSION_REVOCATION_UNAVAILABLE'});}
  });
  app.post('/api/v1/session/location', {schema:{body:{type:'object',additionalProperties:false,required:['latitude','longitude'],properties:{
    latitude:{type:'number',minimum:-90,maximum:90},longitude:{type:'number',minimum:-180,maximum:180}}}}}, async(req,reply)=>{
    try {
      const t=token(req.headers.authorization),owner=await deps.authenticate(t);
      if(!owner||!t)return reply.code(401).send({error:'AUTHENTICATION_REQUIRED'});
      const {latitude,longitude}=req.body as {latitude:number;longitude:number};
      // Coarse, voluntarily reported browser location. Never use it to authenticate or approve spending.
      const result=await deps.pool.query(`UPDATE wallet_access_events SET latitude=$3,longitude=$4 WHERE account_id=$1 AND session_hash=$2`,
        [owner,deps.hash(t),Math.round(latitude*10)/10,Math.round(longitude*10)/10]);
      if(!result.rowCount)return reply.code(404).send({error:'ACCESS_EVENT_NOT_FOUND'});
      return reply.code(204).send();
    } catch {return reply.code(503).send({error:'LOCATION_UNAVAILABLE'});}
  });
}
