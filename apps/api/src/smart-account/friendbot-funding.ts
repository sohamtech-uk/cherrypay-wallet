import type { Pool } from 'pg';
import { rpc, StrKey } from '@stellar/stellar-sdk';
import { db } from '../store.js';
import { PASSPHRASE, requireThat, type Outcome } from '../payments/model.js';
import { verifyOutcome } from '../payments/stellar.js';
import type { DeploymentDescriptor } from './automatic-deployment-chain.js';

export const FRIENDBOT_ALLOCATION_STROOPS = '100000000000';
export type FriendbotFundingStatus = {
  status: 'AVAILABLE'|'PENDING'|'SUBMITTED'|'FUNDED'|'FAILED'|'REVIEW_REQUIRED';
  amountStroops: string; transactionHash?: string; ledger?: number;
};
export interface FriendbotChain {
  verify(descriptor: DeploymentDescriptor, ledger: number): Promise<void>;
  latestLedger(): Promise<number>;
  request(address: string): Promise<string>;
  outcome(hash: string): Promise<Outcome>;
}

/** The provider's hash is discovery only. RPC must prove the exact native SAC receipt. */
export function verifyFriendbotAllocation(outcome: Outcome, hash: string, address: string, startLedger: number) {
  requireThat(outcome.status === 'SUCCESS' && outcome.transactionHash === hash, 'FUNDING_NOT_CONFIRMED');
  requireThat(outcome.events.length === 1, 'FUNDING_RECEIPT_MISMATCH');
  const event = outcome.events[0];
  requireThat(event.transactionHash === hash && StrKey.isValidEd25519PublicKey(event.from) &&
    event.to === address && event.amountStroops === FRIENDBOT_ALLOCATION_STROOPS, 'FUNDING_RECEIPT_MISMATCH');
  requireThat(Number.isSafeInteger(event.ledger) && event.ledger > startLedger, 'INVALID_FUNDING_LEDGER');
  return event.ledger;
}

export class StellarFriendbotChain implements FriendbotChain {
  constructor(readonly server: rpc.Server, readonly verify: FriendbotChain['verify'], private readonly fetcher: typeof fetch = fetch) {}
  async network() { requireThat((await this.server.getNetwork()).passphrase === PASSPHRASE, 'RPC_NETWORK_MISMATCH'); }
  async latestLedger() {
    await this.network();
    const { sequence } = await this.server.getLatestLedger();
    requireThat(Number.isSafeInteger(sequence) && sequence > 0, 'INVALID_FUNDING_LEDGER');
    return sequence;
  }
  async request(address: string) {
    requireThat(StrKey.isValidContract(address), 'CONTRACT_ADDRESS_REQUIRED');
    await this.network();
    // Fixed Testnet endpoint; no caller-controlled URL, recipient, amount or private key.
    // Never retry a POST here: a timeout can follow a committed transfer.
    const response = await this.fetcher('https://friendbot.stellar.org/', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ addr: address }).toString(),
      signal: AbortSignal.timeout(30000), redirect: 'error',
    });
    requireThat(response.ok, 'FRIENDBOT_REQUEST_UNRESOLVED');
    const data: unknown = await response.json();
    const hash = data && typeof data === 'object' && 'hash' in data ? data.hash : undefined;
    // Friendbot does not guarantee its response format. Fail closed if it changes.
    requireThat(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), 'FRIENDBOT_RECEIPT_UNAVAILABLE');
    return hash;
  }
  async outcome(hash: string) { await this.network(); return verifyOutcome(hash, await this.server.getTransaction(hash)); }
}

export class FriendbotFundingService {
  constructor(readonly chain: FriendbotChain, readonly pool: Pool = db) {}
  async queue(owner: string) {
    const result = await this.pool.query(`INSERT INTO wallet_friendbot_funding(account_id,address)
      SELECT account_id,contract_address FROM wallet_deployment_jobs d
      WHERE account_id=$1 AND status='CONFIRMED' AND binding_verified_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM wallet_contract_funding f WHERE f.account_id=d.account_id OR f.address=d.contract_address)
      ON CONFLICT DO NOTHING`, [owner]);
    if (!result.rowCount) {
      const existing = await this.pool.query('SELECT account_id FROM wallet_friendbot_funding WHERE account_id=$1', [owner]);
      requireThat(existing.rowCount === 1, 'VERIFIED_UNFUNDED_C_WALLET_REQUIRED', 409);
    }
    return this.status(owner);
  }
  async status(owner: string): Promise<FriendbotFundingStatus> {
    const { rows } = await this.pool.query(`SELECT status,amount_stroops,transaction_hash,ledger FROM wallet_friendbot_funding WHERE account_id=$1
      UNION ALL SELECT CASE WHEN status='FUNDED' THEN 'FUNDED' ELSE 'REVIEW_REQUIRED' END,
        amount_stroops,transaction_hash,ledger FROM wallet_contract_funding WHERE account_id=$1`, [owner]);
    const r = rows[0];
    return r ? { status: r.status, amountStroops: r.amount_stroops, transactionHash: r.transaction_hash ?? undefined,
      ledger: r.ledger ? Number(r.ledger) : undefined } : { status: 'AVAILABLE', amountStroops: FRIENDBOT_ALLOCATION_STROOPS };
  }
  async tick() {
    const client = await this.pool.connect(); let locked = false;
    const lockName = 'cherrypay-testnet-friendbot';
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockName])).rows[0].locked;
      if (!locked) return;
      // Fair polling: an unresolved grant must not prevent another user's request.
      const { rows } = await client.query(`SELECT f.*,d.descriptor,d.confirmed_ledger FROM wallet_friendbot_funding f
        JOIN wallet_deployment_jobs d ON d.account_id=f.account_id
        WHERE f.status IN ('PENDING','SUBMITTED') ORDER BY f.checked_at NULLS FIRST,f.requested_at,f.account_id LIMIT 1`);
      const j = rows[0]; if (!j) return;
      try {
        await client.query('UPDATE wallet_friendbot_funding SET checked_at=NOW() WHERE account_id=$1', [j.account_id]);
        let hash: string | undefined = j.transaction_hash ?? undefined;
        let startLedger = Number(j.start_ledger);
        if (j.status === 'PENDING') {
          requireThat(j.descriptor?.owner === j.account_id && j.descriptor?.address === j.address, 'INVALID_FUNDING_BINDING');
          await this.chain.verify(j.descriptor, Number(j.confirmed_ledger));
          startLedger = await this.chain.latestLedger();
          // Commit before HTTP. Losing this commit acknowledgement must never send.
          const checkpoint = await client.query(`UPDATE wallet_friendbot_funding
            SET status='SUBMITTED',request_started_at=NOW(),start_ledger=$2 WHERE account_id=$1 AND status='PENDING'`, [j.account_id, startLedger]);
          requireThat(checkpoint.rowCount === 1, 'FUNDING_CHECKPOINT_NOT_COMMITTED');
          hash = await this.chain.request(j.address);
          await client.query('UPDATE wallet_friendbot_funding SET transaction_hash=$2 WHERE account_id=$1 AND transaction_hash IS NULL', [j.account_id, hash]);
        }
        if (!hash) {
          await client.query("UPDATE wallet_friendbot_funding SET status='REVIEW_REQUIRED',failure_code='FRIENDBOT_OUTCOME_UNRESOLVED' WHERE account_id=$1", [j.account_id]);
          return; // No replacement request after a crash, timeout or changed provider response.
        }
        const outcome = await this.chain.outcome(hash);
        if (outcome.status === 'SUCCESS') {
          const ledger = verifyFriendbotAllocation(outcome, hash, j.address, startLedger);
          await client.query("UPDATE wallet_friendbot_funding SET status='FUNDED',ledger=$2,verified_at=NOW(),failure_code=NULL WHERE account_id=$1", [j.account_id, ledger]);
        } else if (outcome.status === 'FAILED') {
          await client.query("UPDATE wallet_friendbot_funding SET status='FAILED',failure_code='FUNDING_TRANSACTION_FAILED' WHERE account_id=$1", [j.account_id]);
        }
      } catch {
        // A persisted hash can be reconciled on the next tick; an unknown request cannot be resent.
        await client.query(`UPDATE wallet_friendbot_funding SET
          status=CASE WHEN status='SUBMITTED' AND transaction_hash IS NULL THEN 'REVIEW_REQUIRED' ELSE status END,
          failure_code='FRIENDBOT_OR_RPC_UNAVAILABLE' WHERE account_id=$1`, [j.account_id]);
      }
    } finally {
      if (locked) { try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]); } catch { client.release(true); return; } }
      client.release();
    }
  }
}
