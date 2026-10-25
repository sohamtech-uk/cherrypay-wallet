import { registerPayrollRoutes } from './payroll/routes.js';
import { registerSmartAccountRoutes } from './smart-account/routes.js';
import { registerIntegrationRoutes } from './integrations/routes.js';
import { PasskeyApprovalService, PostgresApprovalTickets, postgresAssertionVerifier, type ContractPasskeyCodec } from './payments/passkey-approval.js';
import type { PaymentDependencies } from './payments/routes.js';
import type { PaymentService } from './payments/service.js';
import { startPaymentWorker } from './payments/worker.js';
import { registerPaymentRoutes } from './payments/routes.js';
import Fastify from 'fastify';
import {getConfig} from './config.js';
import {beginRegistration,finishRegistration,beginAuthentication,finishAuthentication} from './registration.js';
import {sessionAccount,hashToken,getCredentials,revokeSession,db,getAccountByEmail,emailForAccount} from './store.js';
export async function buildApp(options: { config?: ReturnType<typeof getConfig>; payments?: PaymentService; passkeyCodec?: ContractPasskeyCodec; receiveRoute?: PaymentDependencies['receiveRoute']; logger?: boolean; checkDatabase?: () => Promise<unknown> } = {}) {
const config=options.config??getConfig(),app=Fastify({logger:options.logger??true,trustProxy:'loopback',bodyLimit:32768,ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});
const token=(h:string|undefined)=>h?.startsWith('Bearer ')?h.slice(7):undefined;
const attempts=new Map<string,{count:number;reset:number}>();
function limited(ip:string,route:string){const key=ip+':'+route,now=Date.now(),old=attempts.get(key);if(!old||old.reset<=now){attempts.set(key,{count:1,reset:now+60_000});return false;}old.count++;return old.count>10;}

app.addHook('onRequest',async(req,reply)=>{reply.header('Cache-Control','no-store');reply.header('X-Content-Type-Options','nosniff');if(['POST','PUT','DELETE','PATCH'].includes(req.method)&&req.headers.origin!==config.origin)return reply.code(403).send({error:'Untrusted origin'});if(req.method==='POST'&&req.url.startsWith('/api/v1/passkeys/')&&limited(req.ip,req.url))return reply.code(429).send({error:'Too many attempts'});});
app.get('/health',async()=>({status:'ok',network:'TESTNET',walletDeploymentEnabled:false}));
app.get('/ready',async(_req,reply)=>{try{await (options.checkDatabase??(()=>db.query('SELECT 1')))();return {status:'ready',network:'TESTNET'};}catch{return reply.code(503).send({status:'unavailable'});}});
app.get('/api/v1/network',async()=>({network:config.network,rpcUrl:config.rpcUrl,horizonUrl:config.horizonUrl,walletDeploymentEnabled:false}));
app.post('/api/v1/passkeys/registration/options',async(req,reply)=>{try{const id=(req.body as {accountID?:string}|undefined)?.accountID,t=token(req.headers.authorization);if(id&&await sessionAccount(t)!==id)return reply.code(403).send({error:'Authentication required'});return await beginRegistration(config.rpID,id,id?t:undefined,(req.body as {email?:string}|undefined)?.email);}catch{return reply.code(400).send({error:'Cannot start enrollment'});}});
app.post('/api/v1/passkeys/registration/verify',async(req,reply)=>{try{const {accountID,requestID,response}=req.body as {accountID:string;requestID:string;response:Parameters<typeof finishRegistration>[2]},t=token(req.headers.authorization);if(t&&await sessionAccount(t)!==accountID)return reply.code(403).send({error:'Authentication required'});return await finishRegistration(accountID,requestID,response,config.rpID,config.origin,t);}catch{return reply.code(400).send({error:'Cannot verify enrollment'});}});
app.post('/api/v1/passkeys/authentication/options',async(req,reply)=>{try{const value=(req.body as {accountID?:string;email?:string});const account=value.email?await getAccountByEmail(value.email):undefined;return await beginAuthentication(account?.id??value.accountID??'',config.rpID);}catch{return reply.code(400).send({error:'Cannot start authentication'});}});
app.post('/api/v1/passkeys/authentication/verify',async(req,reply)=>{try{const {accountID,requestID,response}=req.body as {accountID:string;requestID:string;response:Parameters<typeof finishAuthentication>[2]};return await finishAuthentication(accountID,requestID,response,config.rpID,config.origin);}catch{return reply.code(400).send({error:'Cannot verify authentication'});}});
app.get('/api/v1/wallet/me',async(req,reply)=>{const id=await sessionAccount(token(req.headers.authorization));if(!id)return reply.code(401).send({error:'Authentication required'});const credentials=await getCredentials(id);const identity=await emailForAccount(id);return {accountID:id,email:identity?.email??null,emailVerified:!!identity?.email_verified_at,credentialCount:credentials.length,backupCredentialEnrolled:credentials.length>=2,recoveryReady:false,walletDeploymentEnabled:false};});
app.post('/api/v1/session/logout',async(req,reply)=>{const t=token(req.headers.authorization);if(t)await revokeSession(t);return reply.code(204).send();});
await registerSmartAccountRoutes(app);
await registerIntegrationRoutes(app, config.integrations);
// Only trusted startup code may supply a runtime after the B1/B2 contract gate.
const paymentDependencies: PaymentDependencies | undefined = options.payments ? {
  service: options.payments,
  receiveRoute: options.receiveRoute,
  approvals: options.passkeyCodec ? new PasskeyApprovalService(options.payments, new PostgresApprovalTickets(), options.passkeyCodec, postgresAssertionVerifier(config.rpID, config.origin), config.rpID) : undefined,
  origin: config.origin,
  authenticate: async request => {
    const subject = await sessionAccount(token(request.headers.authorization));
    return subject ? { subject, sessionHash: hashToken(token(request.headers.authorization)!) } : null;
  },
} : undefined;
await registerPaymentRoutes(app, paymentDependencies);
await registerPayrollRoutes(app, paymentDependencies);
if (options.payments) {
  let stop: (() => Promise<void>) | undefined;
  app.addHook('onReady', async () => {
    stop = startPaymentWorker(options.payments!, code => app.log.warn({ code }, 'Payment monitor will retry'));
  });
  app.addHook('onClose', async () => { await stop?.(); });
}
return app;
}

