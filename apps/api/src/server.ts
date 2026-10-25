import { registerSmartAccountRoutes } from './smart-account/routes.js';
import { registerPaymentRoutes } from './payments/routes.js';
import Fastify from 'fastify';
import {getConfig} from './config.js';
import {beginRegistration,finishRegistration,beginAuthentication,finishAuthentication} from './registration.js';
import {initializeStore,sessionAccount,getCredentials,revokeSession} from './store.js';
const config=getConfig(),app=Fastify({logger:true,bodyLimit:32768,ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});
const token=(h:string|undefined)=>h?.startsWith('Bearer ')?h.slice(7):undefined;
const attempts=new Map<string,{count:number;reset:number}>();
function limited(ip:string,route:string){const key=ip+':'+route,now=Date.now(),old=attempts.get(key);if(!old||old.reset<=now){attempts.set(key,{count:1,reset:now+60_000});return false;}old.count++;return old.count>10;}

app.addHook('onRequest',async(req,reply)=>{reply.header('Cache-Control','no-store');reply.header('X-Content-Type-Options','nosniff');if(['POST','PUT','DELETE','PATCH'].includes(req.method)&&req.headers.origin!==config.origin)return reply.code(403).send({error:'Untrusted origin'});if(req.method==='POST'&&req.url.startsWith('/api/v1/passkeys/')&&limited(req.ip,req.url))return reply.code(429).send({error:'Too many attempts'});});
app.get('/health',async()=>({status:'ok',network:'TESTNET',walletDeploymentEnabled:false}));
app.get('/api/v1/network',async()=>({network:config.network,rpcUrl:config.rpcUrl,horizonUrl:config.horizonUrl,walletDeploymentEnabled:false}));
app.post('/api/v1/passkeys/registration/options',async(req,reply)=>{try{const id=(req.body as {accountID?:string}|undefined)?.accountID,t=token(req.headers.authorization);if(id&&await sessionAccount(t)!==id)return reply.code(403).send({error:'Authentication required'});return await beginRegistration(config.rpID,id,id?t:undefined);}catch{return reply.code(400).send({error:'Cannot start enrollment'});}});
app.post('/api/v1/passkeys/registration/verify',async(req,reply)=>{try{const {accountID,requestID,response}=req.body as {accountID:string;requestID:string;response:Parameters<typeof finishRegistration>[2]},t=token(req.headers.authorization);if(t&&await sessionAccount(t)!==accountID)return reply.code(403).send({error:'Authentication required'});return await finishRegistration(accountID,requestID,response,config.rpID,config.origin,t);}catch{return reply.code(400).send({error:'Cannot verify enrollment'});}});
app.post('/api/v1/passkeys/authentication/options',async(req,reply)=>{try{return await beginAuthentication((req.body as {accountID:string}).accountID,config.rpID);}catch{return reply.code(400).send({error:'Cannot start authentication'});}});
app.post('/api/v1/passkeys/authentication/verify',async(req,reply)=>{try{const {accountID,requestID,response}=req.body as {accountID:string;requestID:string;response:Parameters<typeof finishAuthentication>[2]};return await finishAuthentication(accountID,requestID,response,config.rpID,config.origin);}catch{return reply.code(400).send({error:'Cannot verify authentication'});}});
app.get('/api/v1/wallet/me',async(req,reply)=>{const id=await sessionAccount(token(req.headers.authorization));if(!id)return reply.code(401).send({error:'Authentication required'});const credentials=await getCredentials(id);return {accountID:id,credentialCount:credentials.length,recoveryReady:credentials.length>=2,walletDeploymentEnabled:false};});
app.post('/api/v1/session/logout',async(req,reply)=>{const t=token(req.headers.authorization);if(t)await revokeSession(t);return reply.code(204).send();});
// Payment routes stay disabled until verified wallet/session adapters are configured.
await registerSmartAccountRoutes(app);
await registerPaymentRoutes(app);
initializeStore().then(()=>app.listen({host:process.env.HOST??'127.0.0.1',port:config.port})).catch(err=>{app.log.error(err);process.exit(1);});


