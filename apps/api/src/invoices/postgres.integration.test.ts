import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { StrKey } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../store.js';
import { databaseConfig } from '../database-config.js';
import { runMigrations } from '../migrations.js';
import { PostgresPaymentRepository } from '../payments/postgres-repository.js';
import { PaymentService } from '../payments/service.js';
import { mockChain } from '../payments/test-fixtures.js';
import { type Intent, type TransferEvent, type Wallet } from '../payments/model.js';
import { InvoiceService, type InvoiceInput } from './service.js';
import { InvoiceWebhookWorker, webhookSignature } from './webhook.js';

describe.skipIf(process.env.RUN_DB_INTEGRATION!=='1')('invoice reconciliation PostgreSQL invariants',()=>{
  const schema='invoices_'+randomUUID().replaceAll('-','');
  const pool=new Pool({...databaseConfig(),options:'-c search_path='+schema,max:8});
  const makeWallet=():Wallet=>({id:randomUUID(),owner:randomUUID(),address:StrKey.encodeContract(randomBytes(32)),policy:'policy',routes:['contract'],createdAt:Date.now()});
  const merchant=makeWallet(),payer=makeWallet(),other=makeWallet();
  const store=new PostgresPaymentRepository(pool),chain=mockChain();
  const payments=new PaymentService(store,chain,{current:async()=>({fingerprint:'policy',recoveryReady:true})},1);
  const invoices=new InvoiceService(payments,pool);
  const input=(reference=randomUUID()):InvoiceInput=>({network:'TESTNET',invoiceReference:reference,merchantName:'Test Merchant',amountStroops:'10000000',expiresAt:Date.now()+86400000});
  const create=(i=input())=>invoices.create(merchant.owner,merchant.id,i);
  const intent=(r:{id:string;destination:string;remainingStroops:string}):Intent=>({network:'TESTNET',destination:r.destination,amountStroops:r.remainingStroops,maxFeeStroops:'10000000',paymentRequestId:r.id});
  let cursor:string|undefined;
  async function receipt(amount='10000000',to=merchant.address,hash=randomBytes(32).toString('hex')):Promise<TransferEvent> {
    const event={id:`TESTNET:${hash}:0:0`,transactionHash:hash,ledger:100,operationIndex:0,eventIndex:0,from:payer.address,to,amountStroops:amount,closedAt:Date.now()};
    const next=randomUUID();await store.ingest([event],cursor,next);cursor=next;return event;
  }
  async function pay(r:Awaited<ReturnType<typeof create>>) {
    const a=await payments.create(payer.owner,payer.id,intent(r),randomUUID());
    const hash=randomBytes(32).toString('hex');
    vi.mocked(chain.authorize).mockResolvedValueOnce({signedXdr:'signed-'+hash,transactionHash:hash});
    const e={id:`TESTNET:${hash}:0:0`,transactionHash:hash,ledger:100,operationIndex:0,eventIndex:0,from:payer.address,to:merchant.address,amountStroops:r.remainingStroops,closedAt:Date.now()};
    vi.mocked(chain.outcome).mockResolvedValueOnce({status:'SUCCESS',transactionHash:hash,events:[e]});
    return payments.approve(payer.owner,payer.id,a.id,'test-auth');
  }
  beforeAll(async()=>{
    await db.query(`CREATE SCHEMA "${schema}"`);await runMigrations(pool);await runMigrations(pool);
    for(const w of [merchant,payer,other]){
      await pool.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES($1,$2)',[w.owner,randomUUID()]);
      await pool.query('INSERT INTO wallet_onchain_accounts(id,owner,address,policy,routes,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[w.id,w.owner,w.address,w.policy,JSON.stringify(w.routes),w.createdAt]);
    }
  },30000);
  beforeEach(async()=>{
    await pool.query('TRUNCATE wallet_invoice_requests,wallet_payment_attempts,wallet_transfer_events,wallet_monitor_cursors CASCADE');cursor=undefined;
    vi.mocked(chain.outcome).mockResolvedValue({status:'NOT_FOUND'});
  });
  afterAll(async()=>{await pool.end();await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);});
  it('recovers concurrent invoice creation, preserves exact amounts and isolates merchant references',async()=>{
    const i={...input(),amountStroops:'9007199254740993'};
    const [a,b]=await Promise.all([create(i),create(i)]);
    expect(a.id).toBe(b.id);expect(a.amountStroops).toBe(i.amountStroops);
    const different=await create({...i,invoiceReference:i.invoiceReference+'-NEW'});
    expect(different.id).not.toBe(a.id);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(different.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(create({...i,amountStroops:'1'})).rejects.toThrow('INVOICE_REFERENCE_CONFLICT');
    expect((await invoices.create(other.owner,other.id,i)).id).not.toBe(a.id);
    await expect(invoices.get(other.owner,merchant.id,a.id)).rejects.toThrow('WALLET_NOT_FOUND');
    await expect(invoices.get(other.owner,other.id,a.id)).rejects.toThrow('PAYMENT_REQUEST_NOT_FOUND');
    expect(await invoices.checkout(a.id)).not.toHaveProperty('receipts');expect(await invoices.checkout(a.id)).not.toHaveProperty('walletId');
  });
  it('rejects tampered destination, amounts, missing references and expired requests before preparation',async()=>{
    const r=await create();
    for(const patch of [{destination:other.address},{amountStroops:'1'},{paymentRequestId:randomUUID()}])await expect(payments.create(payer.owner,payer.id,{...intent(r),...patch},randomUUID())).rejects.toThrow();
    await pool.query('UPDATE wallet_invoice_requests SET expires_at=1 WHERE id=$1',[r.id]);
    await expect(payments.create(payer.owner,payer.id,intent(r),randomUUID())).rejects.toThrow('PAYMENT_REQUEST_EXPIRED');
    expect((await pool.query('SELECT count(*)::int AS n FROM wallet_payment_attempts')).rows[0].n).toBe(0);
  });
  it('binds one unresolved attempt, recovers its key and blocks replacement after unknown submission',async()=>{
    const r=await create(),key=randomUUID();
    const first=await payments.create(payer.owner,payer.id,intent(r),key);
    expect((await payments.create(payer.owner,payer.id,intent(r),key)).id).toBe(first.id);
    const results=await Promise.allSettled([payments.create(other.owner,other.id,intent(r),randomUUID()),payments.create(payer.owner,payer.id,intent(r),randomUUID())]);
    expect(results.every(r=>r.status==='rejected')).toBe(true);
    await payments.approve(payer.owner,payer.id,first.id,'auth');
    await expect(payments.reset(payer.owner,payer.id,key)).rejects.toThrow('CANNOT_CANCEL_SUBMITTED_ATTEMPT');
    expect((await invoices.checkout(r.id)).paymentPending).toBe(true);
  });
  it('matches identical-value invoices only by their immutable request and credits a receipt once across worker restarts',async()=>{
    const a=await create(),b=await create();const paid=await pay(a);expect(paid.verified).toBe(true);
    await expect(payments.create(other.owner,other.id,intent(a),randomUUID())).rejects.toThrow('INVOICE_PAYMENT_UNRESOLVED');
    await Promise.all([invoices.tick(),new InvoiceService(payments,pool).tick()]);
    expect((await invoices.checkout(a.id)).status).toBe('paid');expect((await invoices.checkout(b.id)).status).toBe('unpaid');
    expect((await pool.query('SELECT count(*)::int AS n FROM wallet_invoice_allocations')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM wallet_invoice_outbox')).rows[0].n).toBe(1);
    await expect(payments.create(payer.owner,payer.id,intent(a),randomUUID())).rejects.toThrow('INVOICE_ALREADY_PAID');
    await expect(invoices.allocate(merchant.owner,merchant.id,b.id,paid.eventId!,'same amount only')).rejects.toThrow('RECEIPT_ALREADY_ALLOCATED');
  });
  it('requires one exact payment and rejects partial, excess and duplicate manual settlement',async()=>{
    const r=await create(),partial=await receipt('3000000'),excess=await receipt('11000000'),exact=await receipt(),another=await receipt();
    expect((await invoices.unmatched(merchant.owner,merchant.id)).items).toHaveLength(4);
    await invoices.tick();expect((await invoices.checkout(r.id)).status).toBe('unpaid');
    await expect(invoices.allocate(merchant.owner,merchant.id,r.id,partial.id,'Partial receipt evidence')).rejects.toThrow('INVOICE_EXACT_AMOUNT_REQUIRED');
    await expect(invoices.allocate(merchant.owner,merchant.id,r.id,excess.id,'Excess receipt evidence')).rejects.toThrow('INVOICE_EXACT_AMOUNT_REQUIRED');
    expect((await invoices.checkout(r.id)).paidStroops).toBe('0');
    const result=await invoices.allocate(merchant.owner,merchant.id,r.id,exact.id,'Verified invoice reference and source');
    expect(result.status).toBe('paid');expect(result.paidStroops).toBe('10000000');
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0].actor).toBe(merchant.owner);
    await expect(invoices.allocate(merchant.owner,merchant.id,r.id,another.id,'Attempting a second receipt')).rejects.toThrow('INVOICE_ALREADY_PAID');
    await expect(invoices.allocate(merchant.owner,merchant.id,r.id,exact.id,'Duplicate allocation attempt')).rejects.toThrow('INVOICE_ALREADY_PAID');
    await expect(payments.create(other.owner,other.id,intent(r),randomUUID())).rejects.toThrow('INVOICE_ALREADY_PAID');
    expect((await invoices.unmatched(merchant.owner,merchant.id)).items.map(x=>x.eventId)).toContain(another.id);
    expect((await pool.query('SELECT count(*)::int AS n FROM wallet_invoice_allocations WHERE request_id=$1',[r.id])).rows[0].n).toBe(1);
  });
  it('refuses concurrent exact transfers for one invoice and enforces single allocation in PostgreSQL',async()=>{
    const r=await create(),a=await receipt(),b=await receipt();
    const results=await Promise.allSettled([
      invoices.allocate(merchant.owner,merchant.id,r.id,a.id,'Evidence for payment A'),
      invoices.allocate(merchant.owner,merchant.id,r.id,b.id,'Evidence for payment B')
    ]);
    expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    expect(results.filter(x=>x.status==='rejected')).toHaveLength(1);
    const first=(await invoices.get(merchant.owner,merchant.id,r.id)).receipts[0].eventId;
    const second=first===a.id?b.id:a.id;
    // Even a direct database writer cannot create a second invoice settlement.
    await expect(pool.query(`INSERT INTO wallet_invoice_allocations(event_id,request_id,method,actor,note,created_at)
      VALUES($1,$2,'manual','bypass','direct SQL bypass attempt',$3)`,[second,r.id,Date.now()])).rejects.toThrow();
    expect((await invoices.checkout(r.id)).status).toBe('paid');
  });
  it('database trigger rejects non-exact invoice allocations even if a caller bypasses the API',async()=>{
    const r=await create(),partial=await receipt('5000000');
    await expect(pool.query(`INSERT INTO wallet_invoice_allocations(event_id,request_id,method,actor,note,created_at)
      VALUES($1,$2,'manual','bypass','partial settlement bypass attempt',$3)`,[partial.id,r.id,Date.now()])).rejects.toThrow('INVOICE_EXACT_RECEIPT_REQUIRED');
    expect((await invoices.checkout(r.id)).status).toBe('unpaid');
  });
  it('allows one exact verified receipt after QR expiry, but never a second one',async()=>{
    const r=await create(),e=await receipt(),otherEvent=await receipt();
    await pool.query('UPDATE wallet_invoice_requests SET expires_at=1 WHERE id=$1',[r.id]);
    expect((await invoices.allocate(merchant.owner,merchant.id,r.id,e.id,'Late but independently verified receipt')).status).toBe('paid');
    expect((await invoices.get(merchant.owner,merchant.id,r.id)).receipts[0].late).toBe(true);
    await expect(invoices.allocate(merchant.owner,merchant.id,r.id,otherEvent.id,'Second late receipt refused')).rejects.toThrow('INVOICE_ALREADY_PAID');
  });
  it('prevents receipt theft across merchants and simultaneous allocation to different invoices',async()=>{
    const r=await create(),s=await create(),wrong=await receipt('1',other.address);
    await expect(invoices.allocate(merchant.owner,merchant.id,r.id,wrong.id,'wrong recipient')).rejects.toThrow('RECEIPT_DOES_NOT_MATCH_INVOICE');
    const e=await receipt();
    const results=await Promise.allSettled([invoices.allocate(merchant.owner,merchant.id,r.id,e.id,'Customer confirmed'),invoices.allocate(merchant.owner,merchant.id,s.id,e.id,'Customer confirmed')]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  });
  it('blocks manual settlement while another payer has a potentially live invoice payment',async()=>{
    const r=await create(),a=await payments.create(payer.owner,payer.id,intent(r),randomUUID());
    const e=await receipt();
    await expect(invoices.allocate(merchant.owner,merchant.id,r.id,e.id,'External full payment confirmed')).rejects.toThrow('INVOICE_PAYMENT_UNRESOLVED');
    await payments.cancel(payer.owner,payer.id,a.id);
    const paid=await invoices.allocate(merchant.owner,merchant.id,r.id,e.id,'External full payment confirmed');
    expect(paid.status).toBe('paid');
    await expect(payments.create(payer.owner,payer.id,intent(r),randomUUID())).rejects.toThrow('INVOICE_ALREADY_PAID');
  });
  it('sends authenticated, scoped webhooks with stable IDs, durable retry and concurrent worker fencing',async()=>{
    const r=await create(),e=await receipt();await invoices.allocate(merchant.owner,merchant.id,r.id,e.id,'Invoice confirmed');
    const config={url:'https://accounting.example/webhook',secret:'s'.repeat(32),walletIds:[merchant.id]};
    const send=vi.fn<typeof fetch>().mockRejectedValueOnce(Error('offline')).mockResolvedValue(new Response(null,{status:204}));
    await new InvoiceWebhookWorker(pool,{...config,walletIds:[other.id]},send).tick();expect(send).not.toHaveBeenCalled();
    const worker=new InvoiceWebhookWorker(pool,config,send);await worker.tick();
    const queued=(await pool.query('SELECT * FROM wallet_invoice_outbox')).rows[0];expect(queued.delivered_at).toBeNull();expect(queued.attempts).toBe(1);
    await pool.query('UPDATE wallet_invoice_outbox SET next_attempt_at=0');
    await Promise.all([worker.tick(),new InvoiceWebhookWorker(pool,config,send).tick()]);expect(send).toHaveBeenCalledTimes(2);
    const first=send.mock.calls[0][1]!,second=send.mock.calls[1][1]!,headers=second.headers as Record<string,string>;
    expect(first.body).toBe(second.body);expect(headers['X-CherryPay-Event-Id']).toBe(queued.id);
    expect(headers['X-CherryPay-Signature']).toBe(webhookSignature(config.secret,headers['X-CherryPay-Timestamp'],String(second.body)));
    expect(second.redirect).toBe('error');expect((await pool.query('SELECT delivered_at FROM wallet_invoice_outbox')).rows[0].delivered_at).not.toBeNull();
  });
});
