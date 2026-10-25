import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { databaseConfig } from './database-config.js';
import { runMigrations } from './migrations.js';

// Checksums from the deployed ace9729 release, independent of the current files.
const deployedMigrations = [
  ['001_wallet_identity.sql', '6a8020d8a57b8a4135f209bb51679c93e66f1fefe80be029b1510f26442f49fe'],
  ['002_wallet_payments.sql', '6133cc274b6614d9a233d0fe836b1558d237842675f391f0cef8332f3ec2ec6e'],
  ['003_transfer_approvals.sql', 'f633989f38061570f2e889eb3cf40ffc679cdb24ece6a141050d0f28280f6c4a'],
];
const sql = (name: string) => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

it('retains the checksums already applied to deployed databases', async () => {
  for (const [name, checksum] of deployedMigrations) {
    expect(createHash('sha256').update(await sql(name)).digest('hex'), name).toBe(checksum);
  }
});

describe.skipIf(process.env.RUN_DB_INTEGRATION !== '1')('deployed UUID database upgrade', () => {
  it('preserves accounts, credentials and payment ownership, adds email identities and safely restarts', async () => {
    const schema = 'upgrade_' + randomBytes(8).toString('hex');
    const config = databaseConfig();
    const control = new Pool(config);
    const db = new Pool({ ...config, options: `-c search_path=${schema}` });
    const owner = randomUUID(), challenge = randomUUID(), session = 'a'.repeat(64);
    try {
      await control.query(`CREATE SCHEMA ${schema}`);
      await db.query('CREATE TABLE wallet_schema_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
      for (const [name, checksum] of deployedMigrations) {
        await db.query(await sql(name));
        await db.query('INSERT INTO wallet_schema_migrations(name,sha256) VALUES($1,$2)', [name, checksum]);
      }
      await db.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES($1,$2)', [owner, 'unchanged-webauthn-user']);
      await db.query("INSERT INTO wallet_credentials(id,account_id,public_key,counter) VALUES('credential',$1,'unchanged-key',9)", [owner]);
      await db.query("INSERT INTO wallet_sessions(token_hash,account_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 minutes')", [session, owner]);
      await db.query("INSERT INTO wallet_challenges(id,account_id,purpose,challenge,expires_at) VALUES($1,$2,'authenticate','unchanged-challenge',NOW()+INTERVAL '2 minutes')", [challenge, owner]);
      await db.query("INSERT INTO wallet_onchain_accounts(id,owner,address,policy,created_at) VALUES('wallet',$1,'test-address','test-policy',1)", [owner]);
      await db.query("INSERT INTO wallet_payment_attempts(id,wallet_id,idempotency_key,request_digest,intent,source_address,policy,status,created_at,updated_at,signed_xdr,transaction_hash) VALUES('attempt','wallet','unchanged-key','digest','{}','test-address','test-policy','unknown',1,1,'unchanged-xdr','unchanged-hash')");
      await db.query("INSERT INTO wallet_transfer_approvals(id,owner,wallet_id,attempt_id,session_hash,binding,expires_at) VALUES('approval',$1,'wallet','attempt',$2,'{}',NOW()+INTERVAL '2 minutes')", [owner, session]);
      await db.query("INSERT INTO wallet_monitor_cursors(id,cursor) VALUES('testnet','unchanged-cursor')");

      await runMigrations(db);
      await runMigrations(db);

      expect((await db.query('SELECT id,webauthn_user_id,email_verified_at FROM wallet_accounts')).rows).toEqual([
        { id: owner, webauthn_user_id: 'unchanged-webauthn-user', email_verified_at: null },
      ]);
      expect((await db.query('SELECT account_id,public_key,counter FROM wallet_credentials')).rows[0]).toEqual({ account_id: owner, public_key: 'unchanged-key', counter: '9' });
      expect((await db.query('SELECT account_id FROM wallet_sessions WHERE token_hash=$1', [session])).rows[0].account_id).toBe(owner);
      expect((await db.query('SELECT account_id,challenge FROM wallet_challenges')).rows[0]).toEqual({ account_id: owner, challenge: 'unchanged-challenge' });
      expect((await db.query('SELECT owner FROM wallet_onchain_accounts')).rows[0].owner).toBe(owner);
      expect((await db.query('SELECT owner FROM wallet_transfer_approvals')).rows[0].owner).toBe(owner);
      expect((await db.query('SELECT status,signed_xdr,transaction_hash FROM wallet_payment_attempts')).rows[0]).toEqual({ status: 'unknown', signed_xdr: 'unchanged-xdr', transaction_hash: 'unchanged-hash' });
      expect((await db.query('SELECT cursor FROM wallet_monitor_cursors')).rows[0].cursor).toBe('unchanged-cursor');

      await db.query("INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES('alice@example.com','new-webauthn-user')");
      await db.query("INSERT INTO wallet_email_verifications(account_id,token_hash,expires_at) VALUES('alice@example.com','hash',NOW()+INTERVAL '15 minutes')");
      await expect(db.query("UPDATE wallet_onchain_accounts SET owner='missing@example.com'")).rejects.toMatchObject({ code: '23503' });
      await expect(db.query("UPDATE wallet_transfer_approvals SET owner='missing@example.com'")).rejects.toMatchObject({ code: '23503' });
      await expect(db.query("INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES('Alice@example.com','invalid-normalization')")).rejects.toMatchObject({ code: '23514' });
      await db.query("DELETE FROM wallet_accounts WHERE id='alice@example.com'");
      expect((await db.query('SELECT * FROM wallet_email_verifications')).rows).toEqual([]);
      expect((await db.query('SELECT name FROM wallet_schema_migrations ORDER BY name')).rows.map(r => r.name)).toEqual([...deployedMigrations.map(([name]) => name), '004_email_identity.sql', '004_payroll_runs.sql', '009_wallet_deployment_jobs.sql', '010_automatic_contract_deployment.sql']);

      // Unknown checksum changes must still fail closed, not get silently blessed.
      await db.query("UPDATE wallet_schema_migrations SET sha256='tampered' WHERE name='001_wallet_identity.sql'");
      await expect(runMigrations(db)).rejects.toThrow('Applied migration checksum mismatch');
    } finally {
      await db.end();
      await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await control.end();
    }
  }, 30_000);
});
