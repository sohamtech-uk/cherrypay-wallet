import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../store.js';
import { runMigrations } from '../migrations.js';
import { PostgresPaymentRepository } from '../payments/postgres-repository.js';
import { PaymentService } from '../payments/service.js';
import { mockChain } from '../payments/test-fixtures.js';
import { PayrollService, PostgresPayRunStore, type PayRunInput } from './service.js';
const integration = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
integration('payroll persistence and restart safety', () => {
  const schema = 'payroll_' + randomUUID().replaceAll('-','');
  const pool = new Pool({ ...(process.env.DATABASE_URL ? { connectionString:process.env.DATABASE_URL } : { host:process.env.DB_HOST ?? 'localhost',port:Number(process.env.DB_PORT ?? 5432),database:process.env.DB_NAME ?? 'cherrypay_wallet',user:process.env.DB_USER ?? 'wallet',password:process.env.DB_PASSWORD }),options:'-c search_path=' + schema,max:4 });
  const wallet = { id:randomUUID(),owner:randomUUID(),address:StrKey.encodeContract(randomBytes(32)) };
  const repository = new PostgresPaymentRepository(pool), store = new PostgresPayRunStore(pool);
  const payments = new PaymentService(repository,mockChain(),{current:async () => ({fingerprint:'policy',recoveryReady:true})},1);
  const service = new PayrollService(payments,store);
  const input: PayRunInput = { network:'TESTNET',reference:'october-2026',maxFeeStroops:'10000000',items:[{reference:'employee-1',destination:Keypair.random().publicKey(),amountStroops:'9007199254740993'},{reference:'employee-2',destination:Keypair.random().publicKey(),amountStroops:'1'}] };
  beforeAll(async () => {
    await db.query(`CREATE SCHEMA "${schema}"`); await runMigrations(pool); await runMigrations(pool);
    await pool.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES($1,$2)',[wallet.owner,randomUUID()]);
    await pool.query("INSERT INTO wallet_onchain_accounts(id,owner,address,policy,routes,created_at) VALUES($1,$2,$3,'policy','[\"classic\"]'::jsonb,$4)",[wallet.id,wallet.owner,wallet.address,Date.now()]);
  },30000);
  afterAll(async () => { await pool.end(); await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); });
  it('creates one immutable run under concurrent retries and rejects a changed reference payload',async () => {
    const [a,b] = await Promise.all([service.create(wallet.owner,wallet.id,input),service.create(wallet.owner,wallet.id,input)]);
    expect(a.id).toBe(b.id); expect(a.totalStroops).toBe('9007199254740994');
    await expect(service.create(wallet.owner,wallet.id,{...input,items:[{...input.items[0],amountStroops:'2'}]})).rejects.toThrow('PAY_RUN_REFERENCE_CONFLICT');
    expect((await pool.query('SELECT count(*)::int AS count FROM wallet_payroll_runs')).rows[0].count).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS count FROM wallet_payment_attempts')).rows[0].count).toBe(0);
  });
  it('recovers the persisted line across service instances and uses the global relayer fence',async () => {
    const run = await service.create(wallet.owner,wallet.id,input);
    const first = await service.prepareLine(wallet.owner,wallet.id,run.id,'employee-1');
    const restarted = new PayrollService(payments,new PostgresPayRunStore(pool));
    expect((await restarted.prepareLine(wallet.owner,wallet.id,run.id,'employee-1')).id).toBe(first.id);
    await expect(restarted.prepareLine(wallet.owner,wallet.id,run.id,'employee-2')).rejects.toThrow('RELAYER_BUSY_RESOLVE_EXISTING_ATTEMPT');
    await payments.cancel(wallet.owner,wallet.id,first.id);
    expect((await restarted.prepareLine(wallet.owner,wallet.id,run.id,'employee-1')).status).toBe('rejected');
    const second = await restarted.prepareLine(wallet.owner,wallet.id,run.id,'employee-2');
    expect(second.id).not.toBe(first.id);
    await payments.cancel(wallet.owner,wallet.id,second.id);
    expect((await restarted.get(wallet.owner,wallet.id,run.id)).status).toBe('in_progress');
    expect((await pool.query('SELECT count(*)::int AS count FROM wallet_payment_attempts')).rows[0].count).toBe(2);
  });
  it('isolates ownership and paginates saved runs without duplicates',async () => {
    await expect(service.list(randomUUID(),wallet.id)).rejects.toThrow('WALLET_NOT_FOUND');
    for (let i=0;i<21;i++) await service.create(wallet.owner,wallet.id,{...input,reference:`page-${i}`});
    const first = await service.list(wallet.owner,wallet.id);
    expect(first.items).toHaveLength(20); expect(first.nextCursor).toBeTruthy();
    const second = await service.list(wallet.owner,wallet.id,first.nextCursor);
    expect(second.items).toHaveLength(2); expect(new Set([...first.items,...second.items].map(i => i.id)).size).toBe(22);
  });
});
