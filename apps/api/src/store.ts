import {randomBytes,randomUUID,createHash} from 'node:crypto';
import mysql,{type PoolConnection,type RowDataPacket,type ResultSetHeader} from 'mysql2/promise';
const pool=mysql.createPool({host:process.env.DB_HOST??'127.0.0.1',port:Number(process.env.DB_PORT??3306),user:process.env.DB_USER??'wallet',password:process.env.DB_PASSWORD??'wallet_local_only',database:process.env.DB_NAME??'wallet',waitForConnections:true,connectionLimit:10,timezone:'Z'});
export const db=pool;
export const hashToken=(v:string)=>createHash('sha256').update(v).digest('hex');
export const freshToken=()=>randomBytes(32).toString('base64url');
type Cred={id:string;public_key:string;counter:number|string;transports:string[]};
const normalize=(rows:RowDataPacket[])=>rows.map(r=>({...r,transports:typeof r.transports==='string'?JSON.parse(r.transports):r.transports})) as Cred[];
export async function initializeStore(){
 const statements=[
 'CREATE TABLE IF NOT EXISTS wallet_accounts(id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,webauthn_user_id VARCHAR(128) NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB',
 'CREATE TABLE IF NOT EXISTS wallet_credentials(id VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,public_key TEXT NOT NULL,counter BIGINT UNSIGNED NOT NULL DEFAULT 0,transports JSON NOT NULL,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(account_id) REFERENCES wallet_accounts(id),INDEX(account_id)) ENGINE=InnoDB',
 "CREATE TABLE IF NOT EXISTS wallet_challenges(id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,purpose ENUM('register_initial','register_backup','authenticate') NOT NULL,challenge VARCHAR(512) NOT NULL,session_hash CHAR(64) NULL,expires_at DATETIME(3) NOT NULL,FOREIGN KEY(account_id) REFERENCES wallet_accounts(id),INDEX(expires_at)) ENGINE=InnoDB",
 'CREATE TABLE IF NOT EXISTS wallet_sessions(token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,account_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,expires_at DATETIME(3) NOT NULL,FOREIGN KEY(account_id) REFERENCES wallet_accounts(id),INDEX(expires_at)) ENGINE=InnoDB'
 ];
 for(const statement of statements)await pool.query(statement);
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
