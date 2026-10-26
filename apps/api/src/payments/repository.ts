import { digest, NETWORK, requireThat, type Attempt, type Intent, type TransferEvent, type Wallet } from './model.js';
export type BalanceSnapshot = { amountStroops: string; ledger: number; updatedAt: number };
/** The PostgreSQL implementation supplies this asynchronous boundary.
 * Every mutation must resolve only AFTER COMMIT. Atomic methods must use database locks,
 * not process-local mutexes. See docs/POSTGRESQL_PAYMENT_CONTRACT.md for transaction invariants.
 */
export interface PaymentRepository {
  wallet(id: string, owner: string): Promise<Wallet>;
  /** Owner-scoped discovery, bounded to 101 rows so callers can reject >100. */
  walletsForOwner(owner: string): Promise<Wallet[]>;
  allWallets(): Promise<Wallet[]>;
  get(id: string): Promise<Attempt>;
  byKey(walletId: string, key: string): Promise<Attempt | undefined>;
  create(wallet: Wallet, intent: Intent, key: string): Promise<Attempt>;
  /** Atomically find an existing attempt, or block a late create for an absent key. */
  findOrBlockMissing(wallet:Wallet,key:string):Promise<Attempt|undefined>;
  claim(id: string, statuses: string[]): Promise<{ attempt: Attempt; token: string }>;
  /** Fenced write retaining lease. Used before any RPC with a possible external effect. */
  checkpoint(attempt: Attempt, token: string): Promise<void>;
  /** Fenced attempt + optional events commit, followed by lease release, in one transaction. */
  finish(attempt: Attempt, token: string, events?: TransferEvent[]): Promise<void>;
  list(walletId: string, before?: string): Promise<{ attempt: Attempt; cursor: string }[]>;
  unresolved(): Promise<Attempt[]>;
  cursor(): Promise<string | undefined>;
  /** Insert/dedupe the entire page + CAS cursor in one transaction. Roll back all on any collision. */
  ingest(events: TransferEvent[], expectedCursor: string | undefined, nextCursor: string): Promise<void>;
  history(address: string, before?: string): Promise<{ event: TransferEvent; cursor: string }[]>;
  setBalance(address: string, amount: string, ledger: number): Promise<void>;
  balance(address: string): Promise<BalanceSnapshot | null>;
}
/** Reusable application invariants; the MySQL adapter must enforce these under row locks. */
export function validateAttemptUpdate(previous: Attempt, next: Attempt) {
  requireThat(previous.id === next.id && previous.walletId === next.walletId && previous.idempotencyKey === next.idempotencyKey && previous.requestDigest === next.requestDigest && digest(next.intent) === next.requestDigest && previous.from === next.from && previous.policy === next.policy && previous.createdAt === next.createdAt, 'IMMUTABLE_ATTEMPT_CHANGED');
  requireThat(!previous.signedXdr || previous.signedXdr === next.signedXdr && previous.transactionHash === next.transactionHash, 'SIGNED_TRANSACTION_IMMUTABLE');
  const transitions: Record<string, string[]> = {
    preparing: ['preparing', 'awaiting_approval', 'rejected'], awaiting_approval: ['awaiting_approval', 'authorizing', 'rejected'],
    authorizing: ['authorizing', 'awaiting_approval', 'ready', 'rejected'], ready: ['ready', 'unknown'],
    unknown: ['unknown', 'pending', 'confirmed', 'failed'], pending: ['pending', 'unknown'],
    confirmed: ['confirmed'], failed: ['failed'], rejected: ['rejected'],
  };
  requireThat(transitions[previous.status]?.includes(next.status), 'INVALID_STATUS_TRANSITION');
}
export function validateEventRecord(event: TransferEvent) {
  requireThat(/^[a-f0-9]{64}$/.test(event.transactionHash) && event.id === `${NETWORK}:${event.transactionHash}:${event.operationIndex}:${event.eventIndex}` && Number.isSafeInteger(event.ledger) && event.ledger > 0 && Number.isSafeInteger(event.operationIndex) && event.operationIndex >= 0 && Number.isSafeInteger(event.eventIndex) && event.eventIndex >= 0 && /^[1-9]\d*$/.test(event.amountStroops), 'INVALID_EVENT_RECORD');
}

