import type { PoolClient } from 'pg';
import { NATIVE_SAC, requireThat, type Intent } from '../payments/model.js';

/** Runs under the same transaction as attempt creation, before any RPC side effect. */
export async function assertInvoicePayment(client: PoolClient, intent: Intent, attemptId?: string) {
  if (!intent.paymentRequestId) return;
  const { rows } = await client.query('SELECT * FROM wallet_invoice_requests WHERE id=$1 FOR UPDATE', [intent.paymentRequestId]);
  const r = rows[0];
  requireThat(r, 'PAYMENT_REQUEST_NOT_FOUND', 404);
  requireThat(r.network === intent.network && r.asset_contract === NATIVE_SAC && r.destination === intent.destination, 'PAYMENT_REQUEST_MISMATCH');
  requireThat(Number(r.expires_at) > Date.now(), 'PAYMENT_REQUEST_EXPIRED');
  const total = await client.query(`SELECT COALESCE(sum(e.amount_stroops),0)::text AS paid FROM wallet_invoice_allocations a
    JOIN wallet_transfer_events e ON e.id=a.event_id WHERE a.request_id=$1`, [r.id]);
  // One settlement per invoice, including legacy partial/excess allocations.
  // A historical partially-paid request must never accept a second charge.
  requireThat(BigInt(total.rows[0].paid) === 0n, 'INVOICE_ALREADY_PAID');
  const remaining = BigInt(r.amount_stroops);
  requireThat(remaining > 0n, 'INVOICE_ALREADY_PAID');
  requireThat(remaining.toString() === intent.amountStroops, 'INVOICE_AMOUNT_CHANGED');
  // Includes a confirmed payment awaiting allocation; a worker delay must not permit another charge.
  const active = await client.query(`SELECT 1 FROM wallet_payment_attempts a WHERE a.payment_request_id=$1
    AND ($2::text IS NULL OR a.id<>$2) AND a.status NOT IN ('failed','rejected')
    AND NOT EXISTS (SELECT 1 FROM wallet_invoice_allocations x WHERE x.attempt_id=a.id) LIMIT 1`, [r.id, attemptId ?? null]);
  requireThat(active.rowCount === 0, 'INVOICE_PAYMENT_UNRESOLVED');
}
