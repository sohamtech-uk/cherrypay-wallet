import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { db } from '../store.js';
import { digest, requireThat, TERMINAL, type Attempt, type Intent, type TransferEvent, type Wallet } from './model.js';
import { validateAttemptUpdate, validateEventRecord, type BalanceSnapshot, type PaymentRepository } from './repository.js';

const RELAYER = 'TESTNET:native_xlm_sac:relayer';
const MONITOR = 'TESTNET:native_xlm_sac:monitor';
const copy = <T>(x: T): T => structuredClone(x);
const number = (v: number | string) => Number(v);
const attemptOf = (r: any): Attempt => ({
  id: r.id, walletId: r.wallet_id, idempotencyKey: r.idempotency_key, requestDigest: r.request_digest,
  intent: r.intent, from: r.source_address, policy: r.policy, status: r.status,
  createdAt: number(r.created_at), updatedAt: number(r.updated_at),
  prepared: r.prepared ?? undefined, signedXdr: r.signed_xdr ?? undefined,
  transactionHash: r.transaction_hash ?? undefined, verified: r.verified,
  eventId: r.event_id ?? undefined, failureCode: r.failure_code ?? undefined,
  leaseUntil: number(r.lease_until), leaseToken: r.lease_token ?? undefined,
});
const walletOf = (r: any): Wallet => ({
  id: r.id, owner: r.owner, address: r.address, policy: r.policy, routes: r.routes,
  createdAt: number(r.created_at),
});
const eventOf = (r: any): TransferEvent => ({
  id: r.id, transactionHash: r.transaction_hash, ledger: number(r.ledger),
  operationIndex: number(r.operation_index), eventIndex: number(r.event_index),
  from: r.from_address, to: r.to_address, amountStroops: String(r.amount_stroops),
  closedAt: number(r.closed_at),
});
function encodeCursor(timestamp: number, id: string): string {
  return Buffer.from(JSON.stringify([timestamp,id])).toString('base64url');
}
function decodeCursor(cursor: string): [number,string] {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')); } catch { throw Error('INVALID_CURSOR'); }
  requireThat(Array.isArray(value) && value.length===2 && Number.isSafeInteger(value[0]) && value[0]>=0 && typeof value[1]==='string' && value[1].length>0 && value[1].length<=128, 'INVALID_CURSOR',400);
  return [value[0],value[1]];
}
async function transaction<T>(pool:Pool,work:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const result=await work(client);
    await client.query('COMMIT');
    return result;
  } catch(e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}
async function saved(client:PoolClient,a:Attempt,token:string,release:boolean) {
  const {rows}=await client.query('SELECT * FROM wallet_payment_attempts WHERE id=$1 FOR UPDATE',[a.id]);
  requireThat(rows.length===1 && rows[0].lease_token===token,'LEASE_LOST');
  validateAttemptUpdate(attemptOf(rows[0]),a);
  a.updatedAt=Date.now();
  if(release){a.leaseUntil=0;a.leaseToken=undefined;}
  await client.query(
    'UPDATE wallet_payment_attempts SET status=$2,updated_at=$3,prepared=$4::jsonb,signed_xdr=$5,transaction_hash=$6,verified=$7,event_id=$8,failure_code=$9,lease_until=$10,lease_token=$11 WHERE id=$1',
    [a.id,a.status,a.updatedAt,a.prepared?JSON.stringify(a.prepared):null,a.signedXdr??null,a.transactionHash??null,a.verified,a.eventId??null,a.failureCode??null,a.leaseUntil,a.leaseToken??null]
  );
}
async function insertEvents(client:PoolClient,events:TransferEvent[]) {
  for(const e of events) {
    validateEventRecord(e);
    const {rows}=await client.query('SELECT * FROM wallet_transfer_events WHERE id=$1 FOR UPDATE',[e.id]);
    if(rows.length) {
      requireThat(JSON.stringify(eventOf(rows[0]))===JSON.stringify(e),'EVENT_ID_COLLISION');
      continue;
    }
    await client.query(
      'INSERT INTO wallet_transfer_events(id,transaction_hash,ledger,operation_index,event_index,from_address,to_address,amount_stroops,closed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [e.id,e.transactionHash,e.ledger,e.operationIndex,e.eventIndex,e.from,e.to,e.amountStroops,e.closedAt]
    );
  }
}

/** PostgreSQL application persistence. Never query Wallet Backend's vendor-owned database. */
export class PostgresPaymentRepository implements PaymentRepository {
  constructor(readonly pool:Pool = db, readonly monitorId:string = MONITOR) {}
  async wallet(id:string,owner:string):Promise<Wallet> {
    const {rows}=await this.pool.query('SELECT * FROM wallet_onchain_accounts WHERE id=$1 AND owner=$2 AND network=$3',[id,owner,'TESTNET']);
    requireThat(rows.length===1,'WALLET_NOT_FOUND',404);
    return walletOf(rows[0]);
  }
  async allWallets():Promise<Wallet[]> {
    const {rows}=await this.pool.query('SELECT * FROM wallet_onchain_accounts WHERE network=$1',['TESTNET']);
    return rows.map(walletOf);
  }
  async walletsForOwner(owner:string):Promise<Wallet[]> {
    const {rows}=await this.pool.query('SELECT * FROM wallet_onchain_accounts WHERE owner=$1 AND network=$2 ORDER BY id LIMIT 101',[owner,'TESTNET']);
    return rows.map(walletOf);
  }
  async get(id:string):Promise<Attempt> {
    const {rows}=await this.pool.query('SELECT * FROM wallet_payment_attempts WHERE id=$1',[id]);
    requireThat(rows.length===1,'ATTEMPT_NOT_FOUND',404);
    return attemptOf(rows[0]);
  }
  async byKey(walletId:string,key:string):Promise<Attempt|undefined> {
    const {rows}=await this.pool.query('SELECT * FROM wallet_payment_attempts WHERE wallet_id=$1 AND idempotency_key=$2',[walletId,key]);
    return rows[0]?attemptOf(rows[0]):undefined;
  }
  async findOrBlockMissing(wallet:Wallet,key:string):Promise<Attempt|undefined> {
    requireThat(/^[A-Za-z0-9_-]{16,128}$/.test(key),'INVALID_IDEMPOTENCY_KEY',400);
    return transaction(this.pool,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([wallet.id,key])]);
      const owned=await client.query("SELECT id FROM wallet_onchain_accounts WHERE id=$1 AND owner=$2 AND network='TESTNET'",[wallet.id,wallet.owner]);
      requireThat(owned.rowCount===1,'WALLET_NOT_FOUND',404);
      const prior=await client.query('SELECT * FROM wallet_payment_attempts WHERE wallet_id=$1 AND idempotency_key=$2',[wallet.id,key]);
      if(prior.rows[0])return attemptOf(prior.rows[0]);
      await client.query('INSERT INTO wallet_cancelled_preparations(wallet_id,idempotency_key) VALUES($1,$2) ON CONFLICT DO NOTHING',[wallet.id,key]);
    });
  }
  async create(wallet:Wallet,intent:Intent,key:string):Promise<Attempt> {
    requireThat(/^[A-Za-z0-9_-]{16,128}$/.test(key),'INVALID_IDEMPOTENCY_KEY',400);
    return transaction(this.pool,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([wallet.id,key])]);
      const cancelled=await client.query('SELECT 1 FROM wallet_cancelled_preparations WHERE wallet_id=$1 AND idempotency_key=$2',[wallet.id,key]);
      requireThat(cancelled.rowCount===0,'PAYMENT_PREPARATION_RESET',409);
      await client.query('INSERT INTO wallet_relayer_locks(id) VALUES($1) ON CONFLICT(id) DO NOTHING',[RELAYER]);
      const {rows:locked}=await client.query('SELECT attempt_id FROM wallet_relayer_locks WHERE id=$1 FOR UPDATE',[RELAYER]);
      const {rows:prior}=await client.query('SELECT * FROM wallet_payment_attempts WHERE wallet_id=$1 AND idempotency_key=$2',[wallet.id,key]);
      if(prior.length) {
        requireThat(prior[0].request_digest===digest(intent),'IDEMPOTENCY_CONFLICT');
        return attemptOf(prior[0]);
      }
      const {rows:owned}=await client.query('SELECT id,address,policy FROM wallet_onchain_accounts WHERE id=$1 AND owner=$2 AND network=$3 FOR UPDATE',[wallet.id,wallet.owner,'TESTNET']);
      requireThat(owned.length===1,'WALLET_NOT_FOUND',404);
      requireThat(owned[0].address===wallet.address && owned[0].policy===wallet.policy,'WALLET_METADATA_CHANGED');
      requireThat(!locked[0].attempt_id,'RELAYER_BUSY_RESOLVE_EXISTING_ATTEMPT');
      const now=Date.now();
      const a:Attempt={
        id:randomUUID(),walletId:wallet.id,idempotencyKey:key,requestDigest:digest(intent),intent:copy(intent),
        from:wallet.address,policy:wallet.policy,status:'preparing',createdAt:now,updatedAt:now,verified:false,leaseUntil:0,
      };
      await client.query(
        'INSERT INTO wallet_payment_attempts(id,wallet_id,idempotency_key,request_digest,intent,source_address,policy,status,created_at,updated_at,verified,lease_until) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,FALSE,0)',
        [a.id,a.walletId,a.idempotencyKey,a.requestDigest,JSON.stringify(a.intent),a.from,a.policy,a.status,now,now]
      );
      await client.query('UPDATE wallet_relayer_locks SET attempt_id=$1,updated_at=NOW() WHERE id=$2',[a.id,RELAYER]);
      return a;
    });
  }
  async claim(id:string,statuses:string[]):Promise<{attempt:Attempt;token:string}> {
    return transaction(this.pool,async client=>{
      const {rows}=await client.query('SELECT * FROM wallet_payment_attempts WHERE id=$1 FOR UPDATE',[id]);
      requireThat(rows.length===1 && statuses.includes(rows[0].status) && number(rows[0].lease_until)<=Date.now(),'ATTEMPT_BUSY_OR_INVALID_STATE');
      const token=randomUUID(),until=Date.now()+120_000;
      await client.query('UPDATE wallet_payment_attempts SET lease_token=$2,lease_until=$3 WHERE id=$1',[id,token,until]);
      const a=attemptOf(rows[0]);a.leaseToken=token;a.leaseUntil=until;
      return {attempt:a,token};
    });
  }
  async checkpoint(a:Attempt,token:string):Promise<void> {
    await transaction(this.pool,client=>saved(client,a,token,false));
  }
  async finish(a:Attempt,token:string,events:TransferEvent[]=[]):Promise<void> {
    await transaction(this.pool,async client=>{
      await saved(client,a,token,true);
      await insertEvents(client,events);
      if(TERMINAL.includes(a.status)) {
        const {rows}=await client.query('SELECT attempt_id FROM wallet_relayer_locks WHERE id=$1 FOR UPDATE',[RELAYER]);
        requireThat(rows[0]?.attempt_id===a.id,'RELAYER_RESERVATION_CHANGED');
        await client.query('UPDATE wallet_relayer_locks SET attempt_id=NULL,updated_at=NOW() WHERE id=$1',[RELAYER]);
      }
    });
  }
  async list(walletId:string,before?:string):Promise<{attempt:Attempt;cursor:string}[]> {
    const cursor=before?decodeCursor(before):undefined;
    const {rows}=await this.pool.query('SELECT * FROM wallet_payment_attempts WHERE wallet_id=$1 AND ($2::bigint IS NULL OR (created_at,id)<($2::bigint,$3::text)) ORDER BY created_at DESC,id DESC LIMIT 51',[walletId,cursor?.[0]??null,cursor?.[1]??null]);
    return rows.map(r=>({attempt:attemptOf(r),cursor:encodeCursor(number(r.created_at),r.id)}));
  }
  async unresolved():Promise<Attempt[]> {
    const {rows}=await this.pool.query("SELECT * FROM wallet_payment_attempts WHERE status NOT IN ('confirmed','failed','rejected') ORDER BY created_at ASC");
    return rows.map(attemptOf);
  }
  async cursor():Promise<string|undefined> {
    const {rows}=await this.pool.query('SELECT cursor FROM wallet_monitor_cursors WHERE id=$1',[this.monitorId]);
    return rows[0]?.cursor??undefined;
  }
  async ingest(events:TransferEvent[],expected:string|undefined,next:string):Promise<void> {
    requireThat(typeof next==='string' && next.length>0 && next.length<=1024,'INVALID_EVENT_CURSOR');
    await transaction(this.pool,async client=>{
      await client.query('INSERT INTO wallet_monitor_cursors(id) VALUES($1) ON CONFLICT(id) DO NOTHING',[this.monitorId]);
      const {rows}=await client.query('SELECT cursor FROM wallet_monitor_cursors WHERE id=$1 FOR UPDATE',[this.monitorId]);
      requireThat((rows[0]?.cursor??undefined)===expected,'CURSOR_CHANGED');
      await insertEvents(client,events);
      await client.query('UPDATE wallet_monitor_cursors SET cursor=$2,updated_at=NOW() WHERE id=$1',[this.monitorId,next]);
    });
  }
  async history(address:string,before?:string):Promise<{event:TransferEvent;cursor:string}[]> {
    const cursor=before?decodeCursor(before):undefined;
    const {rows}=await this.pool.query('SELECT * FROM wallet_transfer_events WHERE (from_address=$1 OR to_address=$1) AND ($2::bigint IS NULL OR (ledger,id)<($2::bigint,$3::text)) ORDER BY ledger DESC,id DESC LIMIT 51',[address,cursor?.[0]??null,cursor?.[1]??null]);
    return rows.map(r=>({event:eventOf(r),cursor:encodeCursor(number(r.ledger),r.id)}));
  }
  async setBalance(address:string,amount:string,ledger:number):Promise<void> {
    requireThat(typeof amount==='string' && /^(0|[1-9]\d*)$/.test(amount) && BigInt(amount)<=9223372036854775807n && Number.isSafeInteger(ledger) && ledger>0,'INVALID_BALANCE_SNAPSHOT');
    await this.pool.query('INSERT INTO wallet_balance_snapshots(address,amount_stroops,ledger,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(address) DO UPDATE SET amount_stroops=EXCLUDED.amount_stroops,ledger=EXCLUDED.ledger,updated_at=EXCLUDED.updated_at WHERE wallet_balance_snapshots.ledger<=EXCLUDED.ledger',[address,amount,ledger,Date.now()]);
  }
  async balance(address:string):Promise<BalanceSnapshot|null> {
    const {rows}=await this.pool.query('SELECT * FROM wallet_balance_snapshots WHERE address=$1',[address]);
    return rows[0]?{amountStroops:String(rows[0].amount_stroops),ledger:number(rows[0].ledger),updatedAt:number(rows[0].updated_at)}:null;
  }
}

