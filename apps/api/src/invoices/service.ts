import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { db } from '../store.js';
import { amount, NATIVE_SAC, NETWORK, requireThat } from '../payments/model.js';
import type { PaymentService } from '../payments/service.js';

export type InvoiceInput = { network: 'TESTNET'; invoiceReference: string; merchantName: string; amountStroops: string; expiresAt: number };
export const referencePattern = '^[A-Za-z0-9][A-Za-z0-9 _./-]{0,63}$';
export function validateInvoice(input: InvoiceInput) {
  requireThat(input?.network === NETWORK && typeof input.invoiceReference === 'string' && new RegExp(referencePattern).test(input.invoiceReference), 'INVALID_INVOICE_REFERENCE', 400);
  requireThat(typeof input.merchantName === 'string' && input.merchantName.trim() === input.merchantName && input.merchantName.length > 0 && input.merchantName.length <= 100 && !/[\x00-\x1f\x7f]/.test(input.merchantName), 'INVALID_MERCHANT_NAME', 400);
  amount(input.amountStroops);
  requireThat(Number.isSafeInteger(input.expiresAt) && input.expiresAt > 0, 'INVALID_INVOICE_EXPIRY', 400);
}
export function settlementStatus(expected: string, paid: string) {
  return BigInt(paid) === 0n ? 'unpaid' : BigInt(paid) < BigInt(expected) ? 'partially_paid' : BigInt(paid) === BigInt(expected) ? 'paid' : 'overpaid';
}
export async function invoiceTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export class InvoiceService {
  constructor(readonly payments: PaymentService, readonly pool: Pool = db) {}
  async create(owner: string, walletId: string, input: InvoiceInput) {
    const wallet = await this.payments.store.wallet(walletId, owner);
    validateInvoice(input);
    requireThat(wallet.address.startsWith('C') && wallet.routes.includes('contract'), 'INVOICE_RECEIVE_ROUTE_UNAVAILABLE');
    const fingerprint = createHash('sha256').update(JSON.stringify([input.network, input.invoiceReference, input.merchantName, input.amountStroops, input.expiresAt, wallet.address, NATIVE_SAC])).digest('hex');
    const id = await invoiceTransaction(this.pool, async client => {
      // Stable invoice references recover a lost response, including after expiry.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['invoice',walletId,input.invoiceReference])]);
      const prior = await client.query('SELECT id,request_digest FROM wallet_invoice_requests WHERE wallet_id=$1 AND invoice_reference=$2', [walletId,input.invoiceReference]);
      if (prior.rows[0]) { requireThat(prior.rows[0].request_digest === fingerprint, 'INVOICE_REFERENCE_CONFLICT'); return prior.rows[0].id as string; }
      requireThat(input.expiresAt > Date.now() && input.expiresAt <= Date.now() + 90*86400000, 'INVALID_INVOICE_EXPIRY',400);
      const id = randomUUID();
      await client.query(`INSERT INTO wallet_invoice_requests(id,wallet_id,invoice_reference,merchant_name,network,asset_contract,destination,amount_stroops,expires_at,created_at,request_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id,walletId,input.invoiceReference,input.merchantName,NETWORK,NATIVE_SAC,wallet.address,input.amountStroops,input.expiresAt,Date.now(),fingerprint]);
      return id;
    });
    return this.get(owner,walletId,id);
  }
  async checkout(id: string, connection: Pick<Pool,'query'> = this.pool) {
    const { rows } = await connection.query(`SELECT r.*,COALESCE((SELECT sum(e.amount_stroops) FROM wallet_invoice_allocations a
      JOIN wallet_transfer_events e ON e.id=a.event_id WHERE a.request_id=r.id),0)::text AS paid,
      EXISTS(SELECT 1 FROM wallet_payment_attempts p WHERE p.payment_request_id=r.id AND p.status NOT IN ('failed','rejected')
        AND NOT EXISTS(SELECT 1 FROM wallet_invoice_allocations a WHERE a.attempt_id=p.id)) AS pending
      FROM wallet_invoice_requests r WHERE r.id=$1`, [id]);
    requireThat(rows.length === 1, 'PAYMENT_REQUEST_NOT_FOUND',404);
    const r = rows[0], remaining = BigInt(r.amount_stroops) - BigInt(r.paid);
    requireThat(r.network === NETWORK && r.asset_contract === NATIVE_SAC, 'INVOICE_ASSET_MISMATCH');
    // The unguessable link reveals checkout terms only, never owners, payers or receipt history.
    return { id:r.id as string, network:NETWORK, asset:'XLM' as const, assetContract:NATIVE_SAC, invoiceReference:r.invoice_reference as string,
      merchantName:r.merchant_name as string, destination:r.destination as string, amountStroops:String(r.amount_stroops), paidStroops:String(r.paid),
      remainingStroops:(remaining > 0n ? remaining : 0n).toString(), status:settlementStatus(String(r.amount_stroops),r.paid),
      expiresAt:Number(r.expires_at), expired:Number(r.expires_at) <= Date.now(), paymentPending:!!r.pending, createdAt:Number(r.created_at) };
  }
  async get(owner: string, walletId: string, id: string) {
    await this.payments.store.wallet(walletId,owner);
    return invoiceTransaction(this.pool,async client=>{
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    requireThat((await client.query('SELECT 1 FROM wallet_invoice_requests WHERE id=$1 AND wallet_id=$2',[id,walletId])).rowCount === 1,'PAYMENT_REQUEST_NOT_FOUND',404);
    const request = await this.checkout(id,client);
    const { rows } = await client.query(`SELECT a.event_id AS "eventId",a.method,a.actor,a.note,a.created_at AS "allocatedAt",
      e.transaction_hash AS "transactionHash",e.from_address AS "from",e.amount_stroops::text AS "amountStroops",e.ledger,e.closed_at AS "closedAt"
      FROM wallet_invoice_allocations a JOIN wallet_transfer_events e ON e.id=a.event_id WHERE a.request_id=$1 ORDER BY a.created_at,e.id LIMIT 101`,[id]);
    // Totals cover all receipts; the bounded detail view explicitly reports truncation.
    return {...request,walletId,receipts:rows.slice(0,100).map(r=>({...r,ledger:Number(r.ledger),closedAt:Number(r.closedAt),allocatedAt:Number(r.allocatedAt),late:Number(r.closedAt)>request.expiresAt})),receiptsTruncated:rows.length>100};
    });
  }
  async list(owner: string,walletId: string,before?: string) {
    await this.payments.store.wallet(walletId,owner);
    const prior = before ? await this.get(owner,walletId,before) : undefined;
    const { rows } = await this.pool.query('SELECT id FROM wallet_invoice_requests WHERE wallet_id=$1 AND ($2::bigint IS NULL OR (created_at,id)<($2::bigint,$3::text)) ORDER BY created_at DESC,id DESC LIMIT 21',[walletId,prior?.createdAt??null,before??null]);
    return {network:NETWORK,items:await Promise.all(rows.slice(0,20).map(r=>this.checkout(r.id))),nextCursor:rows.length>20?rows[19].id:undefined};
  }
  async unmatched(owner: string,walletId: string,before?: string) {
    const wallet = await this.payments.store.wallet(walletId,owner);
    const prior = before ? (await this.pool.query('SELECT ledger,id FROM wallet_transfer_events WHERE id=$1 AND to_address=$2',[before,wallet.address])).rows[0] : undefined;
    requireThat(!before || prior,'INVALID_RECEIPT_CURSOR',400);
    const { rows } = await this.pool.query(`SELECT e.id AS "eventId",e.transaction_hash AS "transactionHash",e.from_address AS "from",e.amount_stroops::text AS "amountStroops",e.ledger,e.closed_at AS "closedAt"
      FROM wallet_transfer_events e WHERE e.to_address=$1 AND NOT EXISTS(SELECT 1 FROM wallet_invoice_allocations a WHERE a.event_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM wallet_payment_attempts p WHERE p.payment_request_id IS NOT NULL AND p.transaction_hash=e.transaction_hash)
      AND NOT EXISTS(SELECT 1 FROM wallet_friendbot_funding f WHERE f.transaction_hash=e.transaction_hash)
      AND NOT EXISTS(SELECT 1 FROM wallet_contract_funding f WHERE f.transaction_hash=e.transaction_hash)
      AND ($2::bigint IS NULL OR (e.ledger,e.id)<($2::bigint,$3::text)) ORDER BY e.ledger DESC,e.id DESC LIMIT 21`,[wallet.address,prior?.ledger??null,before??null]);
    return {network:NETWORK,items:rows.slice(0,20).map(r=>({...r,ledger:Number(r.ledger),closedAt:Number(r.closedAt)})),nextCursor:rows.length>20?rows[19].eventId:undefined};
  }
  async allocate(owner: string,walletId: string,id: string,eventId: string,note: string) {
    await this.get(owner,walletId,id);
    requireThat(typeof note === 'string' && note.trim().length >= 5 && note.length <= 500,'RECONCILIATION_NOTE_REQUIRED',400);
    await this.record(id,eventId,{owner,note});
    return this.get(owner,walletId,id);
  }
  private async record(id: string,eventId: string,manual?: {owner:string;note:string}) {
    await invoiceTransaction(this.pool,async client=>{
      const request = (await client.query('SELECT * FROM wallet_invoice_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
      requireThat(request,'PAYMENT_REQUEST_NOT_FOUND',404);
      const event = (await client.query('SELECT * FROM wallet_transfer_events WHERE id=$1 FOR UPDATE',[eventId])).rows[0];
      requireThat(event && event.to_address === request.destination && request.network===NETWORK && request.asset_contract===NATIVE_SAC,'RECEIPT_DOES_NOT_MATCH_INVOICE');
      const prior = (await client.query('SELECT request_id FROM wallet_invoice_allocations WHERE event_id=$1',[eventId])).rows[0];
      if (prior) {
        requireThat(prior.request_id===id,'RECEIPT_ALREADY_ALLOCATED');
        // A worker repeating the same confirmed event is harmless. A second
        // merchant allocation is rejected, even when it names the first receipt.
        requireThat(!manual,'INVOICE_ALREADY_PAID');
        return;
      }
      const allocated = await client.query('SELECT 1 FROM wallet_invoice_allocations WHERE request_id=$1 LIMIT 1',[id]);
      requireThat(allocated.rowCount===0,'INVOICE_ALREADY_PAID');
      // One immutable request ID / QR maps to ONE exact native-XLM receipt.
      // Partial, split, late excess and second receipts never settle an invoice.
      requireThat(String(event.amount_stroops)===String(request.amount_stroops),'INVOICE_EXACT_AMOUNT_REQUIRED');
      const funded = await client.query(`SELECT 1 FROM wallet_friendbot_funding WHERE transaction_hash=$1
        UNION ALL SELECT 1 FROM wallet_contract_funding WHERE transaction_hash=$1 LIMIT 1`,[event.transaction_hash]);
      requireThat(funded.rowCount===0,'SYSTEM_FUNDING_CANNOT_SETTLE_INVOICE');
      const attempts = await client.query('SELECT * FROM wallet_payment_attempts WHERE transaction_hash=$1 AND payment_request_id IS NOT NULL',[event.transaction_hash]);
      let attemptId: string | null = null;
      if (manual) {
        requireThat(attempts.rowCount===0,'RECEIPT_RESERVED_FOR_CHECKOUT');
        // A submitted/unknown invoice transfer could still land on-chain.
        // Never manually settle the same invoice with a different deposit
        // until that existing attempt is conclusively failed or cancelled.
        const unresolved = await client.query(`SELECT 1 FROM wallet_payment_attempts WHERE payment_request_id=$1
          AND status NOT IN ('failed','rejected') LIMIT 1`,[id]);
        requireThat(unresolved.rowCount===0,'INVOICE_PAYMENT_UNRESOLVED');
      } else {
        const a=attempts.rows.find(a=>a.payment_request_id===id && a.event_id===eventId);
        requireThat(a && a.status==='confirmed' && a.verified && a.source_address===event.from_address && a.intent.network===NETWORK && a.intent.destination===event.to_address && a.intent.amountStroops===String(event.amount_stroops),'INVOICE_TRANSFER_NOT_VERIFIED');
        attemptId=a.id;
      }
      const now=Date.now();
      await client.query('INSERT INTO wallet_invoice_allocations(event_id,request_id,attempt_id,method,actor,note,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',[eventId,id,attemptId,manual?'manual':'checkout',manual?.owner??'verified-payment-worker',manual?.note??'Invoice-linked payment verified against committed native XLM transfer',now]);
      const totals=(await client.query(`SELECT sum(e.amount_stroops)::text AS paid,count(*)::int AS version FROM wallet_invoice_allocations a JOIN wallet_transfer_events e ON e.id=a.event_id WHERE a.request_id=$1`,[id])).rows[0];
      const eventKey=randomUUID();
      const payload={id:eventKey,type:'invoice.payment_recorded',version:totals.version,network:NETWORK,walletId:request.wallet_id,paymentRequestId:id,invoiceReference:request.invoice_reference,
        asset:'XLM',assetContract:NATIVE_SAC,destination:request.destination,amountStroops:String(event.amount_stroops),invoiceAmountStroops:String(request.amount_stroops),paidStroops:totals.paid,
        status:settlementStatus(String(request.amount_stroops),totals.paid),transferId:eventId,transactionHash:event.transaction_hash,ledger:Number(event.ledger),closedAt:Number(event.closed_at),
        late:Number(event.closed_at)>Number(request.expires_at),method:manual?'manual':'checkout',createdAt:now};
      await client.query('INSERT INTO wallet_invoice_outbox(id,wallet_id,request_id,event_id,payload,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[eventKey,request.wallet_id,id,eventId,JSON.stringify(payload),now]);
    });
  }
  async tick() {
    const {rows}=await this.pool.query(`SELECT a.payment_request_id,a.event_id FROM wallet_payment_attempts a WHERE a.payment_request_id IS NOT NULL
      AND a.status='confirmed' AND a.verified AND NOT EXISTS(SELECT 1 FROM wallet_invoice_allocations x WHERE x.attempt_id=a.id) ORDER BY a.created_at LIMIT 100`);
    let failed=false;
    for(const r of rows) { try { await this.record(r.payment_request_id,r.event_id); } catch { failed=true; } }
    requireThat(!failed,'INVOICE_RECONCILIATION_RETRY_REQUIRED',503);
  }
}
