import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { db } from '../store.js';
import { amount, digest, publicAttempt, requireThat, validateIntent, type Wallet } from '../payments/model.js';
import type { PaymentService } from '../payments/service.js';

export type PayRunInput = { network: 'TESTNET'; reference: string; maxFeeStroops: string; items: { reference: string; destination: string; amountStroops: string }[] };
export type PayRun = { id: string; walletId: string; input: PayRunInput; createdAt: number; requestDigest: string };
const reference = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function validatePayRun(input: PayRunInput, wallet: Wallet) {
  requireThat(input && input.network === 'TESTNET' && typeof input.reference === 'string' && reference.test(input.reference), 'INVALID_PAY_RUN_REFERENCE_OR_NETWORK', 400);
  requireThat(amount(input.maxFeeStroops) <= 10000000n, 'SPONSOR_FEE_LIMIT', 400);
  requireThat(Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 50, 'PAY_RUN_SIZE_INVALID', 400);
  const refs = new Set<string>(), destinations = new Set<string>();
  let total = 0n;
  for (const row of input.items) {
    requireThat(row && typeof row.reference === 'string' && reference.test(row.reference) && !refs.has(row.reference), 'PAY_RUN_DUPLICATE_OR_INVALID_LINE', 400);
    requireThat(!destinations.has(row.destination), 'PAY_RUN_DUPLICATE_RECIPIENT', 400);
    validateIntent({ network: input.network, destination: row.destination, amountStroops: row.amountStroops, maxFeeStroops: input.maxFeeStroops }, wallet);
    refs.add(row.reference); destinations.add(row.destination); total += amount(row.amountStroops);
  }
  requireThat(total <= 9223372036854775807n, 'PAY_RUN_TOTAL_OVERFLOW', 400);
  return total.toString();
}
export function payRunDigest(input: PayRunInput) {
  return createHash('sha256').update(JSON.stringify([input.network, input.reference, input.maxFeeStroops, input.items.map(i => [i.reference, i.destination, i.amountStroops])])).digest('hex');
}
export function lineKey(run: PayRun, lineReference: string) {
  return 'payroll_' + createHash('sha256').update(JSON.stringify([run.walletId, run.id, lineReference])).digest('hex');
}
export interface PayRunStore {
  create(walletId: string, input: PayRunInput): Promise<PayRun>;
  get(walletId: string, id: string): Promise<PayRun>;
  list(walletId: string, before?: string): Promise<PayRun[]>;
}
const savedRun = (r: any): PayRun => ({ id: r.id, walletId: r.wallet_id, input: r.payload, requestDigest: r.request_digest, createdAt: Number(r.created_at) });
export class PostgresPayRunStore implements PayRunStore {
  constructor(readonly pool: Pool = db) {}
  async create(walletId: string, input: PayRunInput): Promise<PayRun> {
    const requestDigest = payRunDigest(input);
    // ON CONFLICT waits for a concurrent create; a separate statement sees its commit.
    await this.pool.query('INSERT INTO wallet_payroll_runs(id,wallet_id,reference,request_digest,payload,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(wallet_id,reference) DO NOTHING', [randomUUID(), walletId, input.reference, requestDigest, JSON.stringify(input), Date.now()]);
    const { rows } = await this.pool.query('SELECT * FROM wallet_payroll_runs WHERE wallet_id=$1 AND reference=$2', [walletId, input.reference]);
    requireThat(rows.length === 1 && rows[0].request_digest === requestDigest, 'PAY_RUN_REFERENCE_CONFLICT');
    return savedRun(rows[0]);
  }
  async get(walletId: string, id: string) {
    const { rows } = await this.pool.query('SELECT * FROM wallet_payroll_runs WHERE wallet_id=$1 AND id=$2', [walletId, id]);
    requireThat(rows.length === 1, 'PAY_RUN_NOT_FOUND', 404); return savedRun(rows[0]);
  }
  async list(walletId: string, before?: string) {
    const prior = before ? await this.get(walletId, before) : undefined;
    const { rows } = await this.pool.query('SELECT * FROM wallet_payroll_runs WHERE wallet_id=$1 AND ($2::bigint IS NULL OR (created_at,id)<($2::bigint,$3::text)) ORDER BY created_at DESC,id DESC LIMIT 21', [walletId, prior?.createdAt ?? null, prior?.id ?? null]);
    return rows.map(savedRun);
  }
}
export class PayrollService {
  constructor(readonly payments: PaymentService, readonly store: PayRunStore = new PostgresPayRunStore()) {}
  async create(owner: string, walletId: string, input: PayRunInput) {
    const wallet = await this.payments.store.wallet(walletId, owner);
    validatePayRun(input, wallet);
    return this.view(owner, walletId, await this.store.create(walletId, input));
  }
  async get(owner: string, walletId: string, id: string) {
    await this.payments.store.wallet(walletId, owner);
    return this.view(owner, walletId, await this.store.get(walletId, id));
  }
  async list(owner: string, walletId: string, before?: string) {
    await this.payments.store.wallet(walletId, owner);
    const runs = await this.store.list(walletId, before);
    return { network: 'TESTNET', items: runs.slice(0, 20).map(r => ({ id: r.id, reference: r.input.reference, createdAt: r.createdAt, recipientCount: r.input.items.length })), nextCursor: runs.length > 20 ? runs[19].id : undefined };
  }
  private async view(owner: string, walletId: string, run: PayRun) {
    const wallet = await this.payments.store.wallet(walletId, owner);
    // Historical outcomes remain readable if outbound route policy changes.
    const totalStroops = validatePayRun(run.input, { ...wallet, routes: ['classic','contract'] });
    const items = await Promise.all(run.input.items.map(async row => {
      const a = await this.payments.store.byKey(walletId, lineKey(run, row.reference));
      if (a) requireThat(a.requestDigest === digest({ network: 'TESTNET', destination: row.destination, amountStroops: row.amountStroops, maxFeeStroops: run.input.maxFeeStroops }), 'PAY_RUN_ATTEMPT_MISMATCH');
      return { ...row, attempt: a ? publicAttempt(a) : null };
    }));
    const confirmed = items.filter(i => i.attempt?.status === 'confirmed' && i.attempt.verified).length;
    return { id: run.id, walletId, network: 'TESTNET', reference: run.input.reference, createdAt: run.createdAt, maxFeeStroops: run.input.maxFeeStroops, totalStroops, confirmedCount: confirmed, status: confirmed === items.length ? 'completed' : items.some(i => i.attempt) ? 'in_progress' : 'draft', items };
  }
  async prepareLine(owner: string, walletId: string, runId: string, lineReference: string) {
    await this.payments.store.wallet(walletId, owner);
    const run = await this.store.get(walletId, runId);
    const row = run.input.items.find(i => i.reference === lineReference);
    requireThat(row, 'PAY_RUN_LINE_NOT_FOUND', 404);
    // The existing relayer reservation serializes preparation across ALL runs
    // and ordinary sends. Stable keys recover timeouts without creating a retry.
    return publicAttempt(await this.payments.create(owner, walletId, { network: 'TESTNET', destination: row.destination, amountStroops: row.amountStroops, maxFeeStroops: run.input.maxFeeStroops }, lineKey(run, row.reference)));
  }
}
