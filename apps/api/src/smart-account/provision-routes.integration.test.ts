import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { StrKey } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../store.js';
import { runMigrations } from '../migrations.js';
import { parseProvisionArguments, provisionAccounts } from './provision.js';
import { manifestFixture } from './test-support/manifest.js';

it('keeps provisioning dry-run by default and requires an explicit route-upgrade flag', () => {
  expect(parseProvisionArguments([])).toEqual({ apply: false, enableContractRoutes: false });
  expect(parseProvisionArguments(['--check', '--enable-contract-routes'])).toEqual({ apply: false, enableContractRoutes: true });
  expect(parseProvisionArguments(['--apply', '--enable-contract-routes'])).toEqual({ apply: true, enableContractRoutes: true });
  for (const args of [['--apply', '--check'], ['--force'], ['--apply', '--apply'], ['--apply', '--enable-contract-routes', '--check']]) expect(() => parseProvisionArguments(args)).toThrow('INVALID_PROVISION_ARGUMENTS');
});
const integration = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
integration('PostgreSQL explicit contract-route upgrades', () => {
  // Isolate from other suites and their globally reserved relayer/payment records.
  const schema = 'route_upgrade_' + randomUUID().replaceAll('-', '');
  const pool = new Pool({
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : { host: process.env.DB_HOST ?? 'localhost', port: Number(process.env.DB_PORT ?? 5432), database: process.env.DB_NAME ?? 'cherrypay_wallet', user: process.env.DB_USER ?? 'wallet', password: process.env.DB_PASSWORD }),
    options: '-c search_path=' + schema, max: 4,
  });
  // Stubbed chain policy deliberately tests only SQL/provisioning boundaries.
  const policies = { current: async () => ({ fingerprint: 'd'.repeat(64), recoveryReady: true }) };
  beforeAll(async () => { await db.query(`CREATE SCHEMA "${schema}"`); await runMigrations(pool); }, 30000);
  afterAll(async () => { await pool.end(); await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); });
  async function fixture() {
    const manifest = manifestFixture();
    const owner = randomUUID();
    const account = { ...manifest.accounts[0], owner, walletId: randomUUID(), address: StrKey.encodeContract(randomBytes(32)) };
    await pool.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES($1,$2)', [owner, randomUUID()]);
    await pool.query("INSERT INTO wallet_onchain_accounts(id,owner,network,address,policy,routes,created_at) VALUES($1,$2,'TESTNET',$3,$4,'[\"classic\"]'::jsonb,$5)", [account.walletId, owner, account.address, 'd'.repeat(64), Date.now()]);
    return { ...manifest, accounts: [account] };
  }
  async function row(id: string) { return (await pool.query('SELECT * FROM wallet_onchain_accounts WHERE id=$1', [id])).rows[0]; }
  it('does not silently expand old classic-only wallet routes', async () => {
    const m = await fixture();
    await expect(provisionAccounts(m, true, { pool, policies })).rejects.toThrow('EXISTING_WALLET_BINDING_CONFLICT');
    expect((await row(m.accounts[0].walletId)).routes).toEqual(['classic']);
  });
  it('supports dry-run, atomic apply and idempotent reruns without changing ownership or policy', async () => {
    const m = await fixture(), a = m.accounts[0];
    const before = await row(a.walletId);
    expect(await provisionAccounts(m, false, { pool, policies, enableContractRoutes: true })).toMatchObject({ applied: false, wallets: [{ action: 'enable-contract-routes' }] });
    expect(await row(a.walletId)).toEqual(before);
    expect(await provisionAccounts(m, true, { pool, policies, enableContractRoutes: true })).toMatchObject({ applied: true, wallets: [{ action: 'enable-contract-routes' }] });
    expect(await row(a.walletId)).toEqual({ ...before, routes: ['classic', 'contract'] });
    expect(await provisionAccounts(m, true, { pool, policies, enableContractRoutes: true })).toMatchObject({ wallets: [{ action: 'unchanged' }] });
  });
  it.each(['preparing', 'pending', 'unknown'])('refuses an upgrade while a %s attempt remains unresolved', async status => {
    const m = await fixture(), a = m.accounts[0];
    await pool.query('INSERT INTO wallet_payment_attempts(id,wallet_id,idempotency_key,request_digest,intent,source_address,policy,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$9)', [randomUUID(), a.walletId, randomUUID(), 'f'.repeat(64), JSON.stringify({ network: 'TESTNET', destination: a.address, amountStroops: '1', maxFeeStroops: '1000' }), a.address, 'd'.repeat(64), status, Date.now()]);
    await expect(provisionAccounts(m, true, { pool, policies, enableContractRoutes: true })).rejects.toThrow('ROUTE_UPGRADE_REQUIRES_RESOLVED_ATTEMPTS');
    expect((await row(a.walletId)).routes).toEqual(['classic']);
  });
  it('does not use route enablement to overwrite a rotated signer policy', async () => {
    const m = await fixture();
    await expect(provisionAccounts(m, true, { pool, policies: { current: async () => ({ fingerprint: 'e'.repeat(64), recoveryReady: true }) }, enableContractRoutes: true })).rejects.toThrow('EXISTING_WALLET_BINDING_CONFLICT');
    expect(await row(m.accounts[0].walletId)).toMatchObject({ policy: 'd'.repeat(64), routes: ['classic'] });
  });
  it('rolls back the entire batch if a later wallet has a conflicting binding', async () => {
    const first = await fixture(), second = await fixture();
    await pool.query('UPDATE wallet_onchain_accounts SET policy=$2 WHERE id=$1', [second.accounts[0].walletId, 'e'.repeat(64)]);
    await expect(provisionAccounts({ ...first, accounts: [first.accounts[0], second.accounts[0]] }, true, { pool, policies, enableContractRoutes: true })).rejects.toThrow('EXISTING_WALLET_BINDING_CONFLICT');
    expect((await row(first.accounts[0].walletId)).routes).toEqual(['classic']);
    expect((await row(second.accounts[0].walletId)).routes).toEqual(['classic']);
  });
});
