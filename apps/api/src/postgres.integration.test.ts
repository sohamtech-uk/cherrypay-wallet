import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initializeStore, createAccount, createSession, sessionAccount, revokeSession, newChallenge, withLockedAccount, consumeLockedChallenge, credentialsLocked, addCredentialLocked } from './store.js';
import { PostgresPaymentRepository } from './payments/postgres-repository.js';
import { type Intent, type TransferEvent, type Wallet } from './payments/model.js';

const integration = process.env.RUN_DB_INTEGRATION==='1' ? describe : describe.skip;
integration('PostgreSQL wallet integration and transaction invariants', () => {
  const repository = new PostgresPaymentRepository(db);
  let account: {id:string};
  let wallet: Wallet;
  beforeAll(async () => {
    await initializeStore();
    // Re-running checksum-validated migrations must be a no-op.
    await initializeStore();
    account=await createAccount();
    wallet={id:randomUUID(),owner:account.id,address:'C'+'B'.repeat(55),policy:'testnet-policy',routes:['classic'],createdAt:Date.now()};
    await db.query("INSERT INTO wallet_onchain_accounts(id,owner,network,address,policy,routes,created_at) VALUES ($1,$2,'TESTNET',$3,$4,$5::jsonb,$6)",[wallet.id,wallet.owner,wallet.address,wallet.policy,JSON.stringify(wallet.routes),wallet.createdAt]);
  },30_000);
  it('applies identity and payment migrations only once',async () => {
    const {rows}=await db.query('SELECT name FROM wallet_schema_migrations ORDER BY name');
    expect(rows.map(r=>r.name)).toEqual(['001_wallet_identity.sql','002_wallet_payments.sql']);
  });
  it('persists and revokes hashed sessions',async () => {
    const {token}=await createSession(account.id);
    expect(await sessionAccount(token)).toEqual(account.id);
    const result=await db.query('SELECT token_hash FROM wallet_sessions WHERE account_id=$1',[account.id]);
    expect(result.rows[0].token_hash).not.toEqual(token);
    await revokeSession(token);
    expect(await sessionAccount(token)).toBeNull();
  });
  it('consumes a challenge once and serializes first-credential ownership',async () => {
    const requestId=await newChallenge(account.id,'register_initial','challenge');
    expect(await withLockedAccount(account.id,c=>consumeLockedChallenge(c,requestId,account.id,'register_initial'))).toBe('challenge');
    await expect(withLockedAccount(account.id,c=>consumeLockedChallenge(c,requestId,account.id,'register_initial'))).rejects.toThrow();
    const enroll=async (id:string) => withLockedAccount(account.id,async c => {
      const stored=await credentialsLocked(c,account.id);
      if(stored.length) throw Error('Already enrolled');
      await addCredentialLocked(c,account.id,{id,publicKey:new Uint8Array([1,2,3]),counter:0,transports:['internal']});
    });
    const result=await Promise.allSettled([enroll('pk-'+randomUUID()),enroll('pk-'+randomUUID())]);
    expect(result.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    expect(result.filter(x=>x.status==='rejected')).toHaveLength(1);
    const {rows}=await db.query('SELECT count(*)::int AS total FROM wallet_credentials WHERE account_id=$1',[account.id]);
    expect(rows[0].total).toBe(1);
  });
  it('scopes wallets to the authenticated owner',async () => {
    expect(await repository.wallet(wallet.id,account.id)).toMatchObject(wallet);
    await expect(repository.wallet(wallet.id,randomUUID())).rejects.toMatchObject({code:'WALLET_NOT_FOUND'});
  });
  it('serializes idempotent creates and fences one unresolved relayer payment',async () => {
    const intent:Intent={network:'TESTNET',destination:'G'+'A'.repeat(55),amountStroops:'10000000',maxFeeStroops:'1000'};
    const key='payment_'+randomUUID().replaceAll('-','');
    const [first,second]=await Promise.all([repository.create(wallet,intent,key),repository.create(wallet,intent,key)]);
    expect(first.id).toBe(second.id);
    expect(await repository.byKey(wallet.id,key)).toMatchObject({id:first.id});
    await expect(repository.create(wallet,{...intent,amountStroops:'20000000'},key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    await expect(repository.create(wallet,intent,'second_'+key)).rejects.toMatchObject({code:'RELAYER_BUSY_RESOLVE_EXISTING_ATTEMPT'});
    const {attempt,token}=await repository.claim(first.id,['preparing']);
    await expect(repository.claim(first.id,['preparing'])).rejects.toMatchObject({code:'ATTEMPT_BUSY_OR_INVALID_STATE'});
    attempt.status='rejected';
    await repository.finish(attempt,token);
    await expect(repository.checkpoint(attempt,token)).rejects.toMatchObject({code:'LEASE_LOST'});
    const next=await repository.create(wallet,intent,'second_'+key);
    expect(next.id).not.toBe(first.id);
    const claim=await repository.claim(next.id,['preparing']);
    claim.attempt.status='rejected';
    await repository.finish(claim.attempt,claim.token);
  });
  it('rolls back event collisions and cursor changes atomically',async () => {
    const hash='a'.repeat(64);
    const event:TransferEvent={id:'TESTNET:'+hash+':0:0',transactionHash:hash,ledger:1234,operationIndex:0,eventIndex:0,from:wallet.address,to:'G'+'A'.repeat(55),amountStroops:'12345',closedAt:Date.now()};
    expect(await repository.cursor()).toBeUndefined();
    await repository.ingest([event],undefined,'ledger-1234');
    expect(await repository.cursor()).toBe('ledger-1234');
    await expect(repository.ingest([{...event,amountStroops:'55555'}],'ledger-1234','ledger-1235')).rejects.toMatchObject({code:'EVENT_ID_COLLISION'});
    expect(await repository.cursor()).toBe('ledger-1234');
    await expect(repository.ingest([event],'wrong-cursor','ledger-1235')).rejects.toMatchObject({code:'CURSOR_CHANGED'});
    await repository.ingest([event],'ledger-1234','ledger-1235');
    expect((await repository.history(wallet.address))[0].event).toMatchObject(event);
  });
  it('does not overwrite newer balances with stale ledger data',async () => {
    await repository.setBalance(wallet.address,'3000',300);
    await repository.setBalance(wallet.address,'9000',250);
    expect(await repository.balance(wallet.address)).toMatchObject({amountStroops:'3000',ledger:300});
  });
});
