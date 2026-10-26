/** TEST DOUBLE ONLY. No durability, PostgreSQL driver, migrations or production export. */
import { randomUUID } from 'node:crypto';
import { digest, requireThat, TERMINAL, type Attempt, type Intent, type TransferEvent, type Wallet } from '../model.js';
import { validateAttemptUpdate, validateEventRecord, type BalanceSnapshot, type PaymentRepository } from '../repository.js';
const copy = <T>(value: T): T => structuredClone(value);
export class MemoryRepository implements PaymentRepository {
  wallets = new Map<string, Wallet>();
  attempts = new Map<string, Attempt>();
  events = new Map<string, TransferEvent>();
  balances = new Map<string, BalanceSnapshot>();
  currentCursor?: string;
  cancelledKeys=new Set<string>();
  register(wallet: Wallet) { this.wallets.set(wallet.id, copy(wallet)); }
  async wallet(id: string, owner: string) { const wallet = this.wallets.get(id); requireThat(wallet && wallet.owner === owner, 'WALLET_NOT_FOUND', 404); return copy(wallet); }
  async allWallets() { return [...this.wallets.values()].map(copy); }
  async walletsForOwner(owner:string) { return [...this.wallets.values()].filter(w=>w.owner===owner).sort((a,b)=>a.id<b.id?-1:1).slice(0,101).map(copy); }
  private read(id: string) { const a = this.attempts.get(id); requireThat(a, 'ATTEMPT_NOT_FOUND', 404); return copy(a); }
  async get(id: string) { return this.read(id); }
  async byKey(id: string, key: string) { return copy([...this.attempts.values()].find(a => a.walletId === id && a.idempotencyKey === key)); }
  async findOrBlockMissing(wallet:Wallet,key:string){
    requireThat(/^[A-Za-z0-9_-]{16,128}$/.test(key),'INVALID_IDEMPOTENCY_KEY',400);
    const owned=this.wallets.get(wallet.id);requireThat(owned?.owner===wallet.owner,'WALLET_NOT_FOUND',404);
    const prior=[...this.attempts.values()].find(a=>a.walletId===wallet.id&&a.idempotencyKey===key);
    if(prior)return copy(prior);this.cancelledKeys.add(JSON.stringify([wallet.id,key]));
  }
  async create(wallet: Wallet, intent: Intent, key: string) {
    // No await inside this fake's atomic block. Real PostgreSQL MUST use transactions/row locks.
    requireThat(/^[a-zA-Z0-9_-]{16,128}$/.test(key), 'INVALID_IDEMPOTENCY_KEY', 400);
    requireThat(!this.cancelledKeys.has(JSON.stringify([wallet.id,key])),'PAYMENT_PREPARATION_RESET',409);
    const prior = [...this.attempts.values()].find(a => a.walletId === wallet.id && a.idempotencyKey === key);
    if (prior) { requireThat(prior.requestDigest === digest(intent), 'IDEMPOTENCY_CONFLICT'); return copy(prior); }
    requireThat(![...this.attempts.values()].some(a => !TERMINAL.includes(a.status)), 'RELAYER_BUSY_RESOLVE_EXISTING_ATTEMPT');
    const a: Attempt = { id: randomUUID(), walletId: wallet.id, idempotencyKey: key, requestDigest: digest(intent), intent: copy(intent), from: wallet.address, policy: wallet.policy, status: 'preparing', createdAt: Date.now(), updatedAt: Date.now(), verified: false, leaseUntil: 0 };
    this.attempts.set(a.id, copy(a)); return a;
  }
  async claim(id: string, statuses: string[]) {
    const a = this.read(id); requireThat(statuses.includes(a.status) && a.leaseUntil <= Date.now(), 'ATTEMPT_BUSY_OR_INVALID_STATE');
    a.leaseToken = randomUUID(); a.leaseUntil = Date.now() + 120000; this.attempts.set(id, copy(a)); return { attempt: a, token: a.leaseToken };
  }
  private checked(a: Attempt, token: string) {
    const previous = this.read(a.id); requireThat(previous.leaseToken === token, 'LEASE_LOST'); validateAttemptUpdate(previous, a);
  }
  async checkpoint(a: Attempt, token: string) { this.checked(a, token); this.attempts.set(a.id, copy(a)); }
  private validateEvents(events: TransferEvent[]) {
    const seen = new Map(this.events);
    for (const e of events) { validateEventRecord(e); const previous = seen.get(e.id); requireThat(!previous || JSON.stringify(previous) === JSON.stringify(e), 'EVENT_ID_COLLISION'); seen.set(e.id, copy(e)); }
    return seen;
  }
  async finish(a: Attempt, token: string, events: TransferEvent[] = []) {
    this.checked(a, token); const nextEvents = this.validateEvents(events);
    this.events = nextEvents; a.leaseUntil = 0; a.leaseToken = undefined; this.attempts.set(a.id, copy(a));
  }
  async list(id: string, cursor?: string) { return [...this.attempts.values()].filter(a => a.walletId === id && (!cursor || a.id < cursor)).slice(0, 51).map(a => ({ attempt: copy(a), cursor: a.id })); }
  async unresolved() { return [...this.attempts.values()].filter(a => !TERMINAL.includes(a.status)).map(copy); }
  async cursor() { return this.currentCursor; }
  async ingest(events: TransferEvent[], expected: string | undefined, next: string) {
    requireThat(this.currentCursor === expected, 'CURSOR_CHANGED'); const seen = this.validateEvents(events); this.events = seen; this.currentCursor = next;
  }
  async history(address: string, cursor?: string) { return [...this.events.values()].filter(e => (e.from === address || e.to === address) && (!cursor || e.id < cursor)).slice(0, 51).map(e => ({ event: copy(e), cursor: e.id })); }
  async setBalance(address: string, amount: string, ledger: number) { if ((this.balances.get(address)?.ledger ?? 0) <= ledger) this.balances.set(address, { amountStroops: amount, ledger, updatedAt: Date.now() }); }
  async balance(address: string) { return copy(this.balances.get(address) ?? null); }
  // Explicit test setup only; never part of the production repository interface.
  seedAttempt(a: Attempt) { this.attempts.set(a.id, copy(a)); }
}

