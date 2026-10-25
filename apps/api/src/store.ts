import {randomBytes,randomUUID,createHash} from 'node:crypto';
import mysql,{type PoolConnection,type RowDataPacket,type ResultSetHeader} from 'mysql2/promise';
const pool=mysql.createPool({host:process.env.DB_HOST??'127.0.0.1',port:Number(process.env.DB_PORT??3306),user:process.env.DB_USER??'wallet',password:process.env.DB_PASSWORD??'wallet_local_only',database:process.env.DB_NAME??'wallet',waitForConnections:true,connectionLimit:10,timezone:'Z'});
export const db=pool;
export const hashToken=(v:string)=>createHash('sha256').update(v).digest('hex');
export const freshToken=()=>randomBytes(32).toString('base64url');
type Cred={id:string;public_key:string;counter:number|string;transports:string[]};
const normalize=(rows:RowDataPacket[])=>rows.map(r=>({...r,transports:typeof r.transports==='string'?JSON.parse(r.transports):r.transports})) as Cred[];
export async function initializeStore(){
 const {readFile}=await import('node:fs/promises');
 const {fileURLToPath}=await import('node:url');
 const {dirname,resolve}=await import('node:path');
 const schemaPath=resolve(dirname(fileURLToPath(import.meta.url)),'../sql/001_wallet_schema.sql');
 const schema=await readFile(schemaPath,'utf8');
 const expected=['wallet_accounts','wallet_credentials','wallet_challenges','wallet_sessions'];
 const [rows]=await pool.query<RowDataPacket[]>(
  'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?,?,?)',
  expected
 );
 const present=new Set(rows.map(row=>row.name as string));
 if(expected.every(name=>present.has(name)))return;
 // DDL is idempotent and does not modify unrelated Cherry Money tables.
 for(const statement of schema.split(';').map(part=>part.replace(/^\\s*--[^\\n]*\\n/gm,'').trim()).filter(Boolean)){
  await pool.query(statement);
 }
 const [after]=await pool.query<RowDataPacket[]>(
  'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?,?,?)',
  expected
 );
 if(after.length!==expected.length)throw Error('Wallet schema initialization incomplete');
}
export async function createAccount(){
 const id=randomUUID(),userID=randomBytes(32).toString('base64url');
 await pool.execute('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES (?,?)',[id,userID]);return {id,userID};
}
export async function sessionAccount(token:string|undefined){
 if(!token||!/^[a-zA-Z0-9_-]{40,100}$/.test(token))return null;
 const [rows]=await pool.execute<RowDataPacket[]>('SELECT account_id FROM wallet_sessions WHERE token_hash=? AND expires_at>UTC_TIMESTAMP(3)',[hashToken(token)]);
 return (rows[0]?.account_id as string|undefined)??null;
}
export async function createSession(accountID:string){
 const token=freshToken();
 await pool.execute('INSERT INTO wallet_sessions(token_hash,account_id,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 MINUTE))',[hashToken(token),accountID]);
 return {token,expiresInSeconds:1800};
}
export async function revokeSession(token:string){await pool.execute('DELETE FROM wallet_sessions WHERE token_hash=?',[hashToken(token)]);}
export async function getAccount(id:string){
 const [rows]=await pool.execute<RowDataPacket[]>('SELECT id,webauthn_user_id FROM wallet_accounts WHERE id=?',[id]);
 return rows[0] as {id:string;webauthn_user_id:string}|undefined;
}
export async function getCredentials(id:string){
 const [rows]=await pool.execute<RowDataPacket[]>('SELECT id,public_key,counter,transports FROM wallet_credentials WHERE account_id=? ORDER BY created_at',[id]);return normalize(rows);
}
export async function newChallenge(accountID:string,purpose:string,challenge:string,sessionToken?:string){
 const id=randomUUID();
 await pool.execute('INSERT INTO wallet_challenges(id,account_id,purpose,challenge,session_hash,expires_at) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 2 MINUTE))',[id,accountID,purpose,challenge,sessionToken?hashToken(sessionToken):null]);return id;
}
export async function withLockedAccount<T>(accountID:string,work:(client:PoolConnection)=>Promise<T>):Promise<T>{
 const client=await pool.getConnection();
 try{
  await client.beginTransaction();
  const [rows]=await client.execute<RowDataPacket[]>('SELECT id FROM wallet_accounts WHERE id=? FOR UPDATE',[accountID]);
  if(!rows.length)throw Error('Account not found');
  const result=await work(client);await client.commit();return result;
 }catch(error){await client.rollback();throw error;}finally{client.release();}
}
export async function consumeLockedChallenge(client:PoolConnection,id:string,accountID:string,purpose:string,sessionToken?:string){
 const [rows]=await client.execute<RowDataPacket[]>('SELECT challenge FROM wallet_challenges WHERE id=? AND account_id=? AND purpose=? AND expires_at>UTC_TIMESTAMP(3) AND session_hash <=> ? FOR UPDATE',[id,accountID,purpose,sessionToken?hashToken(sessionToken):null]);
 if(rows.length!==1)throw Error('Challenge expired, consumed or unauthorized');
 const [deleted]=await client.execute<ResultSetHeader>('DELETE FROM wallet_challenges WHERE id=?',[id]);
 if(deleted.affectedRows!==1)throw Error('Challenge already consumed');return rows[0].challenge as string;
}
export async function credentialsLocked(client:PoolConnection,accountID:string){
 const [rows]=await client.execute<RowDataPacket[]>('SELECT id,public_key,counter,transports FROM wallet_credentials WHERE account_id=? ORDER BY created_at',[accountID]);return normalize(rows);
}
export async function addCredentialLocked(client:PoolConnection,accountID:string,c:{id:string;publicKey:Uint8Array;counter:number;transports?:string[]}){
 await client.execute('INSERT INTO wallet_credentials(id,account_id,public_key,counter,transports) VALUES (?,?,?,?,?)',[c.id,accountID,Buffer.from(c.publicKey).toString('base64'),c.counter,JSON.stringify(c.transports??[])]);
}
export async function updateCounterLocked(client:PoolConnection,id:string,accountID:string,oldCounter:number,newCounter:number){
 const [result]=await client.execute<ResultSetHeader>('UPDATE wallet_credentials SET counter=? WHERE id=? AND account_id=? AND counter=?',[newCounter,id,accountID,oldCounter]);
 if(result.affectedRows!==1)throw Error('Concurrent authentication detected');
}
