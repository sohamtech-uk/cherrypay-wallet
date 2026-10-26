import { createHash, randomUUID } from 'node:crypto';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/types';
import type { Pool } from 'pg';
import { db, withLockedAccount, credentialsLocked, updateCounterLocked } from '../store.js';
import { requireThat, spendingReady, publicAttempt, type Attempt, type Wallet } from './model.js';
import type { PaymentService } from './service.js';

export type SigningPlan = { challenge: string; credentialIds: string[]; policy: string };
/** Contract adapter must derive the digest and allowed credentials from the CURRENT
 * deployed code and rules, including rule IDs in its digest. No request-supplied policy.
 * encode must preserve the unsigned authorization's nonce/expiry/invocation.
 * The payment service subsequently enforces __check_auth through RPC simulation.
 */
export interface ContractPasskeyCodec {
  describe(wallet: Wallet, attempt: Attempt): Promise<SigningPlan>;
  encode(wallet: Wallet, attempt: Attempt, assertion: AuthenticationResponseJSON): Promise<string>;
}
export type ApprovalBinding = SigningPlan & { authHash: string; requestDigest: string };
export type ApprovalTicket = { id: string; owner: string; walletId: string; attemptId: string; sessionHash: string; binding: ApprovalBinding; expiresAt: number };
export interface ApprovalTickets {
  put(ticket: ApprovalTicket): Promise<void>;
  take(id: string, owner: string, walletId: string, attemptId: string, sessionHash: string): Promise<ApprovalTicket>;
}
export class PostgresApprovalTickets implements ApprovalTickets {
  constructor(private pool: Pool = db) {}
  async put(t: ApprovalTicket) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One writer per session; also verifies it has not been revoked while preparing.
      const session = await client.query('SELECT token_hash FROM wallet_sessions WHERE token_hash=$1 AND account_id=$2 AND expires_at>NOW() FOR UPDATE', [t.sessionHash,t.owner]);
      requireThat(session.rowCount === 1,'AUTHENTICATION_REQUIRED',401);
      await client.query('DELETE FROM wallet_transfer_approvals WHERE expires_at<=NOW()');
      const count = await client.query("SELECT count(*)::int AS count FROM wallet_transfer_approvals WHERE session_hash=$1 AND created_at>NOW()-INTERVAL '1 minute'",[t.sessionHash]);
      requireThat(count.rows[0].count<10,'APPROVAL_RATE_LIMIT',429);
      await client.query('INSERT INTO wallet_transfer_approvals(id,owner,wallet_id,attempt_id,session_hash,binding,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,to_timestamp($7/1000.0))',[t.id,t.owner,t.walletId,t.attemptId,t.sessionHash,JSON.stringify(t.binding),t.expiresAt]);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async take(id:string,owner:string,walletId:string,attemptId:string,sessionHash:string) {
    const {rows}=await this.pool.query(`DELETE FROM wallet_transfer_approvals a USING wallet_sessions s
      WHERE a.id=$1 AND a.owner=$2 AND a.wallet_id=$3 AND a.attempt_id=$4 AND a.session_hash=$5
      AND s.token_hash=a.session_hash AND s.account_id=a.owner AND s.expires_at>NOW() AND a.expires_at>NOW()
      RETURNING a.*, EXTRACT(EPOCH FROM a.expires_at)*1000 AS expiry`,[id,owner,walletId,attemptId,sessionHash]);
    requireThat(rows.length===1,'APPROVAL_EXPIRED_CONSUMED_OR_WRONG_SESSION',409);
    const r=rows[0];return {id:r.id,owner:r.owner,walletId:r.wallet_id,attemptId:r.attempt_id,sessionHash:r.session_hash,binding:r.binding,expiresAt:Number(r.expiry)};
  }
}
export type AssertionVerifier = (owner: string, response: AuthenticationResponseJSON, challenge: string, credentialIds: string[]) => Promise<void>;
export function postgresAssertionVerifier(rpID: string, origin: string): AssertionVerifier {
  return async (owner,response,challenge,ids) => withLockedAccount(owner,async client=>{
    requireThat(ids.includes(response.id),'CREDENTIAL_NOT_AUTHORIZED',403);
    const credential=(await credentialsLocked(client,owner)).find(c=>c.id===response.id);
    requireThat(credential,'CREDENTIAL_NOT_OWNED',403);
    const result=await verifyAuthenticationResponse({response,expectedChallenge:challenge,expectedOrigin:origin,expectedRPID:rpID,requireUserVerification:true,
      credential:{id:credential.id,publicKey:new Uint8Array(Buffer.from(credential.public_key,'base64')),counter:Number(credential.counter),transports:credential.transports as any}});
    requireThat(result.verified,'PASSKEY_VERIFICATION_FAILED',403);
    await updateCounterLocked(client,credential.id,owner,Number(credential.counter),result.authenticationInfo.newCounter);
  });
}
const authHash=(a:Attempt)=>createHash('sha256').update(a.prepared!.authXdr).digest('hex');
export class PasskeyApprovalService {
  constructor(private payments: PaymentService, private tickets: ApprovalTickets, private codec: ContractPasskeyCodec, private verify: AssertionVerifier, private rpID: string) {}
  private async context(owner:string,walletId:string,id:string) {
    const a=await this.payments.get(owner,walletId,id);
    requireThat(a.status==='awaiting_approval' && a.prepared && a.prepared.expiresAt>Date.now(),'ATTEMPT_NOT_AWAITING_APPROVAL');
    const wallet=await this.payments.store.wallet(walletId,owner);
    const current=await this.payments.policies.current(wallet.address);
    requireThat(spendingReady(current) && current.fingerprint===a.policy,'SIGNER_POLICY_CHANGED_OR_RECOVERY_UNREADY');
    const plan=await this.codec.describe(wallet,a);
    requireThat(/^[A-Za-z0-9_-]{43}$/.test(plan.challenge) && Buffer.from(plan.challenge,'base64url').length===32 && plan.policy===a.policy && plan.credentialIds.length>0 && plan.credentialIds.length<=10 && new Set(plan.credentialIds).size===plan.credentialIds.length && plan.credentialIds.every(id=>/^[A-Za-z0-9_-]{1,1024}$/.test(id)),'INVALID_CONTRACT_SIGNING_PLAN');
    return {a,wallet,plan};
  }
  async begin(owner:string,walletId:string,id:string,sessionHash:string) {
    const {a,plan}=await this.context(owner,walletId,id);
    const expiresAt=Math.min(a.prepared!.expiresAt,Date.now()+90000);
    const requestID=randomUUID();
    await this.tickets.put({id:requestID,owner,walletId,attemptId:id,sessionHash,expiresAt,binding:{...plan,authHash:authHash(a),requestDigest:a.requestDigest}});
    return {requestID,attempt:publicAttempt(a),expiresAt:new Date(expiresAt).toISOString(),options:{challenge:plan.challenge,rpId:this.rpID,allowCredentials:plan.credentialIds.map(id=>({id,type:'public-key' as const})),userVerification:'required' as const,timeout:Math.max(1,expiresAt-Date.now())}};
  }
  async finish(owner:string,walletId:string,id:string,sessionHash:string,requestID:string,response:AuthenticationResponseJSON) {
    // Consume commits before cryptographic verification. Invalid/replayed assertions cannot reuse it.
    const ticket=await this.tickets.take(requestID,owner,walletId,id,sessionHash);
    const {a,wallet,plan}=await this.context(owner,walletId,id);
    requireThat(ticket.expiresAt>Date.now() && ticket.binding.authHash===authHash(a) && ticket.binding.requestDigest===a.requestDigest && ticket.binding.challenge===plan.challenge && ticket.binding.policy===plan.policy && JSON.stringify([...ticket.binding.credentialIds].sort())===JSON.stringify([...plan.credentialIds].sort()),'APPROVAL_BINDING_CHANGED');
    await this.verify(owner,response,plan.challenge,plan.credentialIds);
    const authXdr=await this.codec.encode(wallet,a,response);
    return this.payments.approve(owner,walletId,id,authXdr);
  }
}
