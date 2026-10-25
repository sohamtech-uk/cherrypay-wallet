import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {runMigrations} from './migrations.js';
import {databaseConfig} from './database-config.js';

const pool = new Pool(databaseConfig());
// Idle connection failures must not crash the listener or disclose credentials.
pool.on('error', () => console.error('WALLET_DATABASE_CONNECTION_LOST'));
export const db = pool;
export const initializeStore = () => runMigrations(pool);
export const hashToken = (v:string) => createHash('sha256').update(v).digest('hex');
export const freshToken = () => randomBytes(32).toString('base64url');
type Cred = {id:string;public_key:string;counter:string|number;transports:string[]};
function credentials(rows: any[]): Cred[] {
  return rows.map(r => ({...r, transports: typeof r.transports === 'string' ? JSON.parse(r.transports) : r.transports}));
}
export async function createAccount(email?: string) {
  if (!email) throw Error('EMAIL_REQUIRED');
  const id = normalizeEmail(email), userID = randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES($1,$2)',[id,userID]);
  return {id,webauthn_user_id:userID};
}
/** Normalized email is the canonical account ID and permanent ownership key. */
export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(email)) throw Error('INVALID_EMAIL');
  return email;
}
export async function getAccountByEmail(value: string) {
  const email = normalizeEmail(value);
  const { rows } = await pool.query<{id:string;webauthn_user_id:string}>(
    'SELECT id,webauthn_user_id FROM wallet_accounts WHERE id=$1', [email]);
  return rows[0];
}
export async function createEmailVerification(accountID: string) {
  const code = String(randomBytes(4).readUInt32BE(0) % 100000000).padStart(8, '0');
  await pool.query(
    "INSERT INTO wallet_email_verifications(account_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '15 minutes') ON CONFLICT(account_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at",
    [accountID,hashToken(code)]);
  return code;
}
export async function verifyEmail(accountID: string, code: string) {
  if (!/^[0-9]{8}$/.test(code)) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const verified = await client.query(
      "DELETE FROM wallet_email_verifications WHERE account_id=$1 AND token_hash=$2 AND expires_at>NOW() RETURNING account_id",
      [accountID,hashToken(code)]);
    if (verified.rowCount !== 1) { await client.query('ROLLBACK'); return false; }
    await client.query('UPDATE wallet_accounts SET email_verified_at=NOW() WHERE id=$1', [accountID]);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function emailForAccount(accountID: string) {
  const { rows } = await pool.query<{email:string|null;email_verified_at:Date|null}>("SELECT CASE WHEN position('@' in id)>0 THEN id ELSE NULL END AS email, email_verified_at FROM wallet_accounts WHERE id=$1",[accountID]);
  return rows[0];
}
export async function sessionAccount(token:string|undefined):Promise<string|null> {
  if(!token || !/^[a-zA-Z0-9_-]{40,100}$/.test(token)) return null;
  const {rows} = await pool.query<{account_id:string}>('SELECT account_id FROM wallet_sessions WHERE token_hash=$1 AND expires_at>NOW()',[hashToken(token)]);
  return rows[0]?.account_id ?? null;
}
export async function createSession(accountID:string) {
  const token = freshToken();
  await pool.query("INSERT INTO wallet_sessions(token_hash,account_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 minutes')",[hashToken(token),accountID]);
  return {token,expiresInSeconds:1800};
}
export async function revokeSession(token:string) {
  await pool.query('DELETE FROM wallet_sessions WHERE token_hash=$1',[hashToken(token)]);
}
export async function getAccount(id:string) {
  const {rows} = await pool.query<{id:string;webauthn_user_id:string}>('SELECT id,webauthn_user_id FROM wallet_accounts WHERE id=$1',[id]);
  return rows[0];
}
export async function getCredentials(id:string):Promise<Cred[]> {
  const {rows} = await pool.query('SELECT id,public_key,counter,transports FROM wallet_credentials WHERE account_id=$1 ORDER BY created_at',[id]);
  return credentials(rows);
}
export async function newChallenge(accountID:string,purpose:string,challenge:string,sessionToken?:string) {
  const id = randomUUID();
  await pool.query("INSERT INTO wallet_challenges(id,account_id,purpose,challenge,session_hash,expires_at) VALUES($1,$2,$3,$4,$5,NOW()+INTERVAL '2 minutes')",[id,accountID,purpose,challenge,sessionToken?hashToken(sessionToken):null]);
  return id;
}
export async function withLockedAccount<T>(accountID:string,work:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {rows} = await client.query('SELECT id FROM wallet_accounts WHERE id=$1 FOR UPDATE',[accountID]);
    if(!rows.length) throw Error('Account not found');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function consumeLockedChallenge(client:PoolClient,id:string,accountID:string,purpose:string,sessionToken?:string):Promise<string> {
  const {rows} = await client.query<{challenge:string}>("DELETE FROM wallet_challenges WHERE id=$1 AND account_id=$2 AND purpose=$3 AND expires_at>NOW() AND session_hash IS NOT DISTINCT FROM $4 RETURNING challenge",[id,accountID,purpose,sessionToken?hashToken(sessionToken):null]);
  if(rows.length!==1) throw Error('Challenge expired, consumed or unauthorized');
  return rows[0].challenge;
}
export async function credentialsLocked(client:PoolClient,accountID:string):Promise<Cred[]> {
  const {rows} = await client.query('SELECT id,public_key,counter,transports FROM wallet_credentials WHERE account_id=$1 ORDER BY created_at',[accountID]);
  return credentials(rows);
}
export async function addCredentialLocked(client:PoolClient,accountID:string,c:{id:string;publicKey:Uint8Array;counter:number;transports?:string[]}) {
  await client.query('INSERT INTO wallet_credentials(id,account_id,public_key,counter,transports) VALUES($1,$2,$3,$4,$5::jsonb)',[c.id,accountID,Buffer.from(c.publicKey).toString('base64'),c.counter,JSON.stringify(c.transports??[])]);
}
export async function updateCounterLocked(client:PoolClient,id:string,accountID:string,oldCounter:number,newCounter:number) {
  if(!Number.isSafeInteger(newCounter) || newCounter<0) throw Error('Invalid signature counter');
  const result = await client.query('UPDATE wallet_credentials SET counter=$1 WHERE id=$2 AND account_id=$3 AND counter=$4',[newCounter,id,accountID,oldCounter]);
  if(result.rowCount!==1) throw Error('Concurrent authentication detected');
}

