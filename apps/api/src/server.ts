import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { getConfig } from './config.js';
import { accountSummary,beginRegistration,finishRegistration,beginAuthentication,finishAuthentication } from './registration.js';
const config=getConfig();const app=Fastify({logger:true,bodyLimit:32*1024});
app.addHook('onRequest',async(request,reply)=>{reply.header('Cache-Control','no-store');reply.header('X-Content-Type-Options','nosniff');if(request.method==='POST'){const origin=request.headers.origin;if(origin!==config.origin){reply.code(403).send({error:'Untrusted origin'});return;}}});
app.get('/health',async()=>({status:'ok',network:config.network,walletDeploymentEnabled:false}));
app.get('/api/v1/network',async()=>({network:config.network,rpcUrl:config.rpcUrl,horizonUrl:config.horizonUrl,walletDeploymentEnabled:false}));
app.post('/api/v1/passkeys/registration/options',async(request,reply)=>{try{const {accountID}=request.body as {accountID:string};return await beginRegistration(accountID,config.rpID);}catch(e){return reply.code(400).send({error:(e as Error).message});}});
app.post('/api/v1/passkeys/registration/verify',async(request,reply)=>{try{const {accountID,requestID,response}=request.body as {accountID:string;requestID:string;response:Parameters<typeof finishRegistration>[2]};return await finishRegistration(accountID,requestID,response,config.rpID,config.origin);}catch{return reply.code(400).send({error:'Passkey registration could not be verified'});}});
app.post('/api/v1/passkeys/authentication/options',async(request,reply)=>{try{const {accountID}=request.body as {accountID:string};return await beginAuthentication(accountID,config.rpID);}catch{return reply.code(400).send({error:'Cannot begin authentication'});}});
app.post('/api/v1/passkeys/authentication/verify',async(request,reply)=>{try{const {accountID,requestID,response}=request.body as {accountID:string;requestID:string;response:Parameters<typeof finishAuthentication>[2]};return await finishAuthentication(accountID,requestID,response,config.rpID,config.origin);}catch{return reply.code(400).send({error:'Passkey authentication could not be verified'});}});
// No account discovery, wallet creation or transaction signing until a verified smart-account adapter exists.
app.setNotFoundHandler((_request,reply)=>reply.code(404).send({error:'Not found'}));
app.listen({host:'127.0.0.1',port:config.port}).catch(error=>{app.log.error(error);process.exit(1);});
