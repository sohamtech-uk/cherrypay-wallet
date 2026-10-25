import { randomBytes, randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
const pool = new pg.Pool({connectionString:process.env.DATABASE_URL ?? 'postgres://wallet:wallet_local_only@127.0.0.1:5432/wallet',max:10});
export const db = pool;
export const hashToken = (value:string) => createHash('sha256').update(value).digest('hex');
export const freshToken = () => randomBytes(32).toString('base64url');
export async function initializeStore(){
 await pool.query(`CREATE TABLE IF NOT EXISTS wallet_accounts (
 id uuid PRIMARY KEY, webauthn_user_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
 ); CREATE TABLE IF NOT EXISTS wallet_credentials (
 id text PRIMARY KEY, account_id uuid NOT NULL REFERENCES wallet_accounts(id),
 public_key text NOT NULL, counter bigint NOT NULL DEFAULT 0, transports jsonb NOT NULL DEFAULT '[]'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
 ); CREATE TABLE IF NOT EXISTS wallet_challenges (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES wallet_accounts(id),
 purpose text NOT NULL CHECK (purpose IN ('register_initial','register_backup','authenticate')),
 challenge text NOT NULL, session_hash text, expires_at timestamptz NOT NULL
 ); CREATE TABLE IF NOT EXISTS wallet_sessions (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES wallet_accounts(id),
 expires_at timestamptz NOT NULL
 );`);
}
export async function createAccount(){
 const id=randomUUID(),userID=randomBytes(32).toString('base64url');
 await pool.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES ($1,$2)',[id,userID]);
 return {id,userID};
}
export async function sessionAccount(token:string|undefined){
 if(!token || !/^[a-zA-Z0-9_-]{40,100}$/.test(token)) return null;
 const {rows}=await pool.query('SELECT account_id FROM wallet_sessions WHERE token_hash=$1 AND expires_at>now()',[hashToken(token)]);
 return rows[0]?.account_id as string|undefined ?? null;
}
export async function createSession(accountID:string){
 const token=freshToken();
 await pool.query("INSERT INTO wallet_sessions(token_hash,account_id,expires_at) VALUES ($1,$2,now()+interval '30 minutes')",[hashToken(token),accountID]);
 return {token,expiresInSeconds:1800};
}
export async function revokeSession(token:string){await pool.query('DELETE FROM wallet_sessions WHERE token_hash=$1',[hashToken(token)]);}
export async function getAccount(id:string){
 const {rows}=await pool.query('SELECT id,webauthn_user_id FROM wallet_accounts WHERE id=$1',[id]);return rows[0] as {id:string;webauthn_user_id:string}|undefined;
}
export async function getCredentials(id:string){
 const {rows}=await pool.query('SELECT id,public_key,counter,transports FROM wallet_credentials WHERE account_id=$1 ORDER BY created_at',[id]);
 return rows as Array<{id:string;public_key:string;counter:string;transports:string[]}>;
}
export async function newChallenge(accountID:string,purpose:string,challenge:string,sessionToken?:string){
 const requestID=randomUUID();
 await pool.query("INSERT INTO wallet_challenges(id,account_id,purpose,challenge,session_hash,expires_at) VALUES ($1,$2,$3,$4,$5,now()+interval '2 minutes')",[requestID,accountID,purpose,challenge,sessionToken?hashToken(sessionToken):null]);
 return requestID;
}
export async function consumeChallenge(id:string,accountID:string,purpose:string,sessionToken?:string){
 // DELETE RETURNING guarantees only one concurrent verifier can consume a challenge.
 const {rows}=await pool.query('DELETE FROM wallet_challenges WHERE id=$1 AND account_id=$2 AND purpose=$3 AND expires_at>now() AND session_hash IS NOT DISTINCT FROM $4 RETURNING challenge',[id,accountID,purpose,sessionToken?hashToken(sessionToken):null]);
 if(!rows[0]) throw new Error('Challenge expired, consumed or unauthorized');
 return rows[0].challenge as string;
}
export async function addCredential(accountID:string,c:{id:string;publicKey:Uint8Array;counter:number;transports?:string[]}){
 await pool.query('INSERT INTO wallet_credentials(id,account_id,public_key,counter,transports) VALUES($1,$2,$3,$4,$5)',[c.id,accountID,Buffer.from(c.publicKey).toString('base64'),c.counter,JSON.stringify(c.transports??[])]);
}
export async function updateCounter(id:string,accountID:string,oldCounter:number,newCounter:number){
 const {rowCount}=await pool.query('UPDATE wallet_credentials SET counter=$1 WHERE id=$2 AND account_id=$3 AND counter=$4',[newCounter,id,accountID,oldCounter]);
 if(rowCount!==1)throw new Error('Credential counter changed concurrently');
}
