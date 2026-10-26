import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { StrKey } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../store.js';
import { runMigrations } from '../migrations.js';
import { PostgresPaymentRepository } from './postgres-repository.js';
import type { TransferEvent } from './model.js';

const integration = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
integration('C-to-C PostgreSQL balances, history and ownership', () => {
  const schema = 'cc_payment_' + randomUUID().replaceAll('-', '');
  const pool = new Pool({
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : { host: process.env.DB_HOST ?? 'localhost', port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME ?? 'cherrypay_wallet', user: process.env.DB_USER ?? 'wallet', password: process.env.DB_PASSWORD }),
    options: '-c search_path=' + schema, max: 4,
  });
  const repository = new PostgresPaymentRepository(pool);
  const alice = { id: randomUUID(), owner: randomUUID(), address: StrKey.encodeContract(randomBytes(32)) };
  const bob = { id: randomUUID(), owner: randomUUID(), address: StrKey.encodeContract(randomBytes(32)) };
  beforeAll(async () => {
    await db.query(`CREATE SCHEMA "${schema}"`); await runMigrations(pool);
    for (const w of [alice, bob]) {
      await pool.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES($1,$2)', [w.owner, randomUUID()]);
      await pool.query("INSERT INTO wallet_onchain_accounts(id,owner,network,address,policy,routes,created_at) VALUES($1,$2,'TESTNET',$3,$4,'[\"classic\",\"contract\"]'::jsonb,$5)", [w.id, w.owner, w.address, 'a'.repeat(64), Date.now()]);
    }
  }, 30000);
  afterAll(async () => { await pool.end(); await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); });
  it('makes one canonical transfer visible to both users without duplicating indexed records', async () => {
    const hash = 'b'.repeat(64);
    const event: TransferEvent = { id: `TESTNET:${hash}:0:0`, transactionHash: hash, ledger: 100, operationIndex: 0, eventIndex: 0, from: alice.address, to: bob.address, amountStroops: '9007199254740993', closedAt: 1000 };
    await repository.ingest([event], undefined, 'page-1');
    await repository.ingest([event], 'page-1', 'page-2');
    const sender = await repository.history(alice.address), recipient = await repository.history(bob.address);
    expect(sender).toHaveLength(1); expect(recipient).toHaveLength(1);
    expect(sender[0].event).toEqual(event); expect(recipient[0].event).toEqual(event);
    expect((await pool.query('SELECT count(*)::int AS count FROM wallet_transfer_events')).rows[0].count).toBe(1);
    expect(await repository.history(bob.address, recipient[0].cursor)).toEqual([]);
  });
  it('persists exact balances larger than JavaScript safe integers and rejects stale snapshots', async () => {
    await repository.setBalance(alice.address, '10992800745259007', 100);
    await repository.setBalance(bob.address, '9007199254740993', 100);
    await repository.setBalance(bob.address, '0', 99);
    expect(await repository.balance(alice.address)).toMatchObject({ amountStroops: '10992800745259007', ledger: 100 });
    expect(await repository.balance(bob.address)).toMatchObject({ amountStroops: '9007199254740993', ledger: 100 });
  });
  it('keeps wallet discovery and account access isolated for the two users', async () => {
    expect((await repository.walletsForOwner(alice.owner)).map(w => w.id)).toEqual([alice.id]);
    expect((await repository.walletsForOwner(bob.owner)).map(w => w.id)).toEqual([bob.id]);
    await expect(repository.wallet(alice.id, bob.owner)).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
    await expect(repository.wallet(bob.id, alice.owner)).rejects.toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });
});
