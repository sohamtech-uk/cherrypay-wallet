import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { StrKey } from '@stellar/stellar-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../store.js';
import { runMigrations } from '../migrations.js';
import { resolveRecipient, setDirectoryPreference } from './directory.js';
const integration = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
integration('verified email recipient directory', () => {
  const schema = 'recipients_' + randomUUID().replaceAll('-','');
  const pool = new Pool({ ...(process.env.DATABASE_URL ? { connectionString:process.env.DATABASE_URL } :
    {host:process.env.DB_HOST ?? 'localhost',port:Number(process.env.DB_PORT ?? 5432),
     database:process.env.DB_NAME ?? 'cherrypay_wallet',user:process.env.DB_USER ?? 'wallet',password:process.env.DB_PASSWORD}),
     options:'-c search_path=' + schema, max:4 });
  const recipient='receiver@example.com',sender='sender@example.com';
  const address=StrKey.encodeContract(randomBytes(32));
  beforeAll(async () => {
    await db.query(`CREATE SCHEMA "${schema}"`);
    await runMigrations(pool);await runMigrations(pool);
    for (const email of [sender,recipient])
      await pool.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES($1,$2)',[email,randomUUID()]);
    await pool.query("INSERT INTO wallet_onchain_accounts(id,owner,address,policy,routes,created_at) VALUES($1,$2,$3,'policy','[\"contract\"]'::jsonb,$4)",
      ['receiver-wallet',recipient,address,Date.now()]);
    await pool.query("INSERT INTO wallet_deployment_jobs(account_id,status,contract_address,transaction_hash,confirmed_ledger,signer_rule_id,binding_verified_at) VALUES($1,'CONFIRMED',$2,$3,123,0,NOW())",
      [recipient,address,'a'.repeat(64)]);
  },30000);
  afterAll(async()=>{await pool.end();await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);});
  it('never exposes an account before mailbox verification and explicit opt-in',async()=>{
    await expect(resolveRecipient(recipient,sender,pool)).rejects.toThrow('RECIPIENT_NOT_AVAILABLE');
    await expect(setDirectoryPreference(recipient,true,pool)).rejects.toThrow('VERIFIED_EMAIL_AND_WALLET_REQUIRED');
    await pool.query('UPDATE wallet_accounts SET email_verified_at=NOW() WHERE id=$1',[recipient]);
    await expect(resolveRecipient(recipient,sender,pool)).rejects.toThrow('RECIPIENT_NOT_AVAILABLE');
    await expect(setDirectoryPreference(recipient,true,pool)).resolves.toEqual({emailVerified:true,emailPaymentsEnabled:true});
    expect(await resolveRecipient('Receiver@Example.com',sender,pool)).toEqual({
      network:'TESTNET',email:recipient,address,mailboxVerified:true,walletBindingVerified:true,legalIdentityVerified:false
    });
  });
  it('does not reveal the sender, unbound contracts, or opted-out recipients',async()=>{
    await expect(resolveRecipient(sender,sender,pool)).rejects.toThrow('RECIPIENT_NOT_AVAILABLE');
    await pool.query('UPDATE wallet_deployment_jobs SET binding_verified_at=NULL WHERE account_id=$1',[recipient]);
    await expect(resolveRecipient(recipient,sender,pool)).rejects.toThrow('RECIPIENT_NOT_AVAILABLE');
    await expect(setDirectoryPreference(recipient,true,pool)).rejects.toThrow('VERIFIED_EMAIL_AND_WALLET_REQUIRED');
    await pool.query('UPDATE wallet_deployment_jobs SET binding_verified_at=NOW() WHERE account_id=$1',[recipient]);
    await expect(setDirectoryPreference(recipient,false,pool)).resolves.toMatchObject({emailPaymentsEnabled:false});
    await expect(resolveRecipient(recipient,sender,pool)).rejects.toThrow('RECIPIENT_NOT_AVAILABLE');
  });
  it('fails closed if mailbox verification is revoked',async()=>{
    await pool.query('UPDATE wallet_accounts SET email_verified_at=NULL WHERE id=$1',[recipient]);
    await expect(setDirectoryPreference(recipient,true,pool)).rejects.toThrow('VERIFIED_EMAIL_AND_WALLET_REQUIRED');
    await expect(resolveRecipient(recipient,sender,pool)).rejects.toThrow('RECIPIENT_NOT_AVAILABLE');
  });
});
