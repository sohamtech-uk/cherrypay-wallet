import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PaymentDependencies } from '../payments/routes.js';
import { PaymentError } from '../payments/model.js';
import { InvoiceService, referencePattern, type InvoiceInput } from './service.js';

const id={type:'string',pattern:'^[a-f0-9-]{36}$'};
const walletId={type:'string',pattern:'^[A-Za-z0-9_-]{1,128}$'};
const eventId={type:'string',pattern:'^TESTNET:[a-f0-9]{64}:[0-9]+:[0-9]+$',maxLength:128};
export const invoiceInputSchema={type:'object',additionalProperties:false,required:['network','invoiceReference','merchantName','amountStroops','expiresAt'],properties:{
  network:{type:'string',const:'TESTNET'},invoiceReference:{type:'string',pattern:referencePattern},merchantName:{type:'string',minLength:1,maxLength:100},
  amountStroops:{type:'string',pattern:'^[1-9][0-9]{0,18}$'},expiresAt:{type:'integer',minimum:1}
}};
export const allocationSchema={type:'object',additionalProperties:false,required:['eventId','note'],properties:{eventId,note:{type:'string',minLength:5,maxLength:500}}};
export async function registerInvoiceRoutes(app:FastifyInstance,deps?:PaymentDependencies,service=deps?new InvoiceService(deps.service):undefined) {
  await app.register(async scope=>{
    const owners=new WeakMap<FastifyRequest,string>();
    scope.addHook('onRequest',async(req,reply)=>{
      reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Robots-Tag','noindex');
      if(!deps||!service)return reply.code(503).send({error:'PAYMENT_INTEGRATION_NOT_CONFIGURED'});
      // Only the checkout-terms endpoint is public. Authentication is mandatory elsewhere.
      if(req.method==='GET' && req.routeOptions.url==='/api/v1/payment-requests/:requestId')return;
      if(req.method!=='GET'&&req.headers.origin!==deps.origin)return reply.code(403).send({error:'UNTRUSTED_ORIGIN'});
      const principal=await deps.authenticate(req);
      if(!principal)return reply.code(401).send({error:'AUTHENTICATION_REQUIRED'});
      owners.set(req,principal.subject);
    });
    scope.setErrorHandler((e,_req,reply)=>reply.code(e instanceof PaymentError?e.status:e.validation?400:503).send({error:e instanceof PaymentError?e.code:e.validation?'INVALID_REQUEST':'INVOICE_SERVICE_UNAVAILABLE'}));
    const params=(withId=false)=>({type:'object',additionalProperties:false,required:withId?['walletId','requestId']:['walletId'],properties:{walletId,...(withId?{requestId:id}:{})}});
    const context=(req:FastifyRequest)=>({owner:owners.get(req)!,...(req.params as {walletId:string;requestId:string})});
    const base='/api/v1/wallets/:walletId/invoices';
    scope.get('/api/v1/payment-requests/:requestId',{schema:{params:{type:'object',additionalProperties:false,required:['requestId'],properties:{requestId:id}},querystring:{type:'object',additionalProperties:false}}},async req=>service!.checkout((req.params as {requestId:string}).requestId));
    scope.post(base,{schema:{params:params(),body:invoiceInputSchema}},async req=>{const c=context(req);return service!.create(c.owner,c.walletId,req.body as InvoiceInput);});
    scope.get(base,{schema:{params:params(),querystring:{type:'object',additionalProperties:false,properties:{cursor:id}}}},async req=>{const c=context(req);return service!.list(c.owner,c.walletId,(req.query as {cursor?:string}).cursor);});
    scope.get(`${base}/:requestId`,{schema:{params:params(true)}},async req=>{const c=context(req);return service!.get(c.owner,c.walletId,c.requestId);});
    scope.post(`${base}/:requestId/allocate`,{schema:{params:params(true),body:allocationSchema}},async req=>{const c=context(req),b=req.body as {eventId:string;note:string};return service!.allocate(c.owner,c.walletId,c.requestId,b.eventId,b.note);});
    scope.get('/api/v1/wallets/:walletId/unmatched-receipts',{schema:{params:params(),querystring:{type:'object',additionalProperties:false,properties:{cursor:eventId}}}},async req=>{const c=context(req);return service!.unmatched(c.owner,c.walletId,(req.query as {cursor?:string}).cursor);});
  });
  return service;
}
