import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { digest } from '../payments/model.js';
import { intent, mockChain, mockPolicy, wallet } from '../payments/test-fixtures.js';
import { MemoryRepository } from '../payments/test-support/memory-repository.js';
import { PaymentService } from '../payments/service.js';
import { registerInvoiceRoutes } from './routes.js';
import { InvoiceService, settlementStatus, validateInvoice } from './service.js';
import { invoiceWebhookConfig, webhookSignature } from './webhook.js';

const id='70adce38-46c1-49a3-8a38-0e9cccf71756';
describe('invoice input and payment boundaries',()=>{
  it('binds the invoice in the intent digest without changing existing payment digests',()=>{
    expect(digest({...intent,paymentRequestId:id})).not.toBe(digest(intent));
    expect(digest({...intent,paymentRequestId:id})).not.toBe(digest({...intent,paymentRequestId:'b'.repeat(36)}));
    expect(digest({...intent,paymentRequestId:undefined})).toBe(digest(intent));
  });
  it('validates exact amounts, references and network',()=>{
    const input={network:'TESTNET' as const,invoiceReference:'INV-2026/125',merchantName:'Cherry Money',amountStroops:'9007199254740993',expiresAt:Date.now()+10000};
    expect(()=>validateInvoice(input)).not.toThrow();
    for(const override of [{network:'MAINNET'},{amountStroops:'1.5'},{amountStroops:'0'},{invoiceReference:'<script>'},{merchantName:'\nmerchant'}])expect(()=>validateInvoice({...input,...override} as typeof input)).toThrow();
    expect(['0','9','10','11'].map(p=>settlementStatus('10',p))).toEqual(['unpaid','partially_paid','paid','overpaid']);
  });
  it('requires invoice persistence guards before signing',async()=>{
    const store=new MemoryRepository();store.register(wallet);const chain=mockChain();
    const service=new PaymentService(store,chain,mockPolicy(),1);
    const a=await service.create(wallet.owner,wallet.id,{...intent,paymentRequestId:id},'invoice-safety-key-0001');
    expect((await service.approve(wallet.owner,wallet.id,a.id,'auth')).failureCode).toBe('INVOICE_INTEGRATION_NOT_CONFIGURED');
    expect(chain.authorize).not.toHaveBeenCalled();
  });
});
describe('invoice routes',()=>{
  it('allows public checkout terms, requires owner sessions for details and trusted origin for writes',async()=>{
    const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});
    const stub={checkout:vi.fn(async()=>({id,network:'TESTNET'})),get:vi.fn(async()=>({id})),create:vi.fn(),allocate:vi.fn()} as unknown as InvoiceService;
    await registerInvoiceRoutes(app,{origin:'https://wallet.example',service:{} as PaymentService,authenticate:async req=>req.headers.authorization==='Bearer valid'?{subject:'owner'}:null},stub);
    expect((await app.inject(`/api/v1/payment-requests/${id}`)).statusCode).toBe(200);
    expect((await app.inject(`/api/v1/wallets/merchant/invoices/${id}`)).statusCode).toBe(401);
    expect((await app.inject({url:`/api/v1/wallets/merchant/invoices/${id}`,headers:{authorization:'Bearer valid'}})).statusCode).toBe(200);
    expect((await app.inject({method:'POST',url:`/api/v1/wallets/merchant/invoices/${id}/allocate`,headers:{authorization:'Bearer valid',origin:'https://evil.example'},payload:{}})).statusCode).toBe(403);
    expect((await app.inject(`/api/v1/payment-requests/${id}?destination=tampered`)).statusCode).toBe(400);
    expect(stub.allocate).not.toHaveBeenCalled();await app.close();
  });
});
describe('invoice webhook configuration',()=>{
  it('is opt-in, requires a destination secret and explicit merchant wallet scope',()=>{
    expect(invoiceWebhookConfig({})).toBeUndefined();
    expect(()=>invoiceWebhookConfig({WALLET_INVOICE_WEBHOOK_URL:'http://example.com/hook'})).toThrow();
    const env={WALLET_INVOICE_WEBHOOK_URL:'https://accounting.example/invoice-hook',WALLET_INVOICE_WEBHOOK_SECRET:'s'.repeat(32),WALLET_INVOICE_WEBHOOK_WALLET_IDS:'merchant-a,merchant-b'};
    expect(invoiceWebhookConfig(env)?.walletIds).toEqual(['merchant-a','merchant-b']);
    expect(()=>invoiceWebhookConfig({...env,WALLET_INVOICE_WEBHOOK_WALLET_IDS:''})).toThrow();
    expect(webhookSignature(env.WALLET_INVOICE_WEBHOOK_SECRET,'100','body')).not.toBe(webhookSignature(env.WALLET_INVOICE_WEBHOOK_SECRET,'100','tampered'));
  });
});
