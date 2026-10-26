import { StrKey } from '@stellar/stellar-sdk';
import type { PaymentRepository } from './repository.js';
import { digest, PaymentError, requireThat, spendingReady, TERMINAL, validateIntent, type Chain, type Intent, type PolicyReader, type Wallet } from './model.js';

export class PaymentService {
  constructor(readonly store: PaymentRepository, readonly chain: Chain, readonly policies: PolicyReader, readonly startLedger: number, readonly syncWallets?:()=>Promise<void>, readonly monitorWallets?:()=>Promise<void>) {
    requireThat(Number.isSafeInteger(startLedger) && startLedger > 0, 'START_LEDGER_REQUIRED');
  }
  private async policy(wallet: Wallet, fingerprint = wallet.policy) {
    const current = await this.policies.current(wallet.address);
    requireThat(spendingReady(current) && current.fingerprint === fingerprint, 'SIGNER_POLICY_CHANGED_OR_RECOVERY_UNREADY');
  }
  private async recipient(wallet: Wallet, intent: Intent) {
    if (!StrKey.isValidContract(intent.destination)) return;
    // A checksum-valid C address alone is not a supported receiving wallet.
    const recipient = (await this.store.allWallets()).find(w => w.address === intent.destination);
    requireThat(recipient && recipient.id !== wallet.id && recipient.routes.includes('contract'), 'UNVERIFIED_CONTRACT_RECIPIENT', 400);
    const current = await this.policies.current(recipient.address);
    requireThat(spendingReady(current) && current.fingerprint === recipient.policy, 'RECIPIENT_RECOVERY_OR_POLICY_UNREADY');
  }
  async get(owner: string, walletId: string, id: string) {
    await this.store.wallet(walletId, owner); const a = await this.store.get(id);
    requireThat(a.walletId === walletId, 'ATTEMPT_NOT_FOUND', 404); return a;
  }
  async create(owner: string, walletId: string, intent: Intent, key: string) {
    const wallet = await this.store.wallet(walletId, owner); validateIntent(intent, wallet);
    // Recover the durable attempt BEFORE querying chain policy. A recipient outage
    // or rotation must not hide a previous submission or invite a replacement key.
    const prior = await this.store.byKey(walletId, key);
    if (prior) { requireThat(prior.requestDigest === digest(intent), 'IDEMPOTENCY_CONFLICT'); return prior; }
    await this.recipient(wallet, intent);
    await this.policy(wallet);
    const a = await this.store.create(wallet, intent, key);
    try { return await this.prepare(a.id); }
    catch (error) { if (error instanceof PaymentError && error.code === 'ATTEMPT_BUSY_OR_INVALID_STATE') return this.store.get(a.id); throw error; }
  }
  private async prepare(id: string) {
    const { attempt: a, token } = await this.store.claim(id, ['preparing']);
    try {
      const wallet = (await this.store.allWallets()).find(w => w.id === a.walletId);
      requireThat(wallet, 'WALLET_NOT_FOUND', 404);
      validateIntent(a.intent, wallet);
      await this.policy(wallet, a.policy);
      await this.recipient(wallet, a.intent);
      a.prepared = await this.chain.prepare(wallet, a.intent);
      await this.recipient(wallet, a.intent);
      a.status = 'awaiting_approval'; a.failureCode = undefined;
    } catch (error) {
      a.status = error instanceof PaymentError ? 'rejected' : 'preparing';
      a.failureCode = error instanceof PaymentError ? error.code : 'RPC_UNAVAILABLE';
    }
    await this.store.finish(a, token); return a;
  }
  async approve(owner: string, walletId: string, id: string, authXdr: string) {
    const existing = await this.get(owner, walletId, id);
    if (existing.signedXdr || TERMINAL.includes(existing.status)) return existing;
    const { attempt: a, token } = await this.store.claim(id, ['awaiting_approval', 'authorizing']);
    a.status = 'authorizing'; await this.store.checkpoint(a, token);
    try {
      requireThat(a.prepared && a.prepared.expiresAt > Date.now(), 'QUOTE_EXPIRED');
      const wallet = await this.store.wallet(walletId, owner);
      validateIntent(a.intent, wallet);
      await this.policy(wallet, a.policy);
      await this.recipient(wallet, a.intent);
      const signed = await this.chain.authorize(wallet, a.intent, a.prepared, authXdr);
      // Refuse changes discovered during the asynchronous authorization check.
      await this.policy(wallet, a.policy);
      await this.recipient(wallet, a.intent);
      a.signedXdr = signed.signedXdr; a.transactionHash = signed.transactionHash;
      a.status = 'ready'; a.failureCode = undefined;
    } catch (error) {
      a.status = error instanceof PaymentError ? 'rejected' : 'awaiting_approval';
      a.failureCode = error instanceof PaymentError ? error.code : 'RPC_UNAVAILABLE';
    }
    await this.store.finish(a, token);
    return a.signedXdr ? this.reconcile(a.id) : a;
  }
  async cancel(owner: string, walletId: string, id: string) {
    const existing = await this.get(owner, walletId, id);
    requireThat(!existing.signedXdr, 'CANNOT_CANCEL_SUBMITTED_ATTEMPT');
    const { attempt: a, token } = await this.store.claim(id, ['preparing', 'awaiting_approval', 'authorizing']);
    a.status = 'rejected'; a.failureCode = 'USER_CANCELLED'; await this.store.finish(a, token); return a;
  }
  async reset(owner:string,walletId:string,key:string) {
    const wallet=await this.store.wallet(walletId,owner);
    const prior=await this.store.findOrBlockMissing(wallet,key);
    if(!prior)return {reset:true as const,outcome:'not_created' as const};
    if(TERMINAL.includes(prior.status)) {
      requireThat(prior.status!=='confirmed'||prior.verified,'TRANSFER_NOT_INDEPENDENTLY_VERIFIED');
      return {reset:true as const,outcome:prior.status,attempt:prior};
    }
    const cancelled=await this.cancel(owner,walletId,prior.id);
    return {reset:true as const,outcome:'cancelled' as const,attempt:cancelled};
  }
  async reconcile(id: string) {
    const existing = await this.store.get(id); if (TERMINAL.includes(existing.status)) return existing;
    const { attempt: a, token } = await this.store.claim(id, ['ready', 'pending', 'unknown']);
    requireThat(a.signedXdr && a.transactionHash && a.prepared, 'MISSING_SIGNED_TRANSACTION');
    a.status = 'unknown'; await this.store.checkpoint(a, token);
    try {
      // Always establish the outcome first. A later signer change cannot undo an
      // already successful transfer or turn an unknown submission into a failure.
      const outcome = await this.chain.outcome(a.transactionHash);
      if (outcome.status === 'SUCCESS') {
        requireThat(outcome.transactionHash === a.transactionHash, 'TRANSACTION_HASH_MISMATCH');
        const matches = outcome.events.filter(e => e.transactionHash === a.transactionHash && e.from === a.from && e.to === a.intent.destination && e.amountStroops === a.intent.amountStroops);
        requireThat(matches.length === 1, 'TRANSFER_NOT_INDEPENDENTLY_VERIFIED');
        a.status = 'confirmed'; a.verified = true; a.eventId = matches[0].id; a.failureCode = undefined;
        await this.store.finish(a, token, matches); return a;
      }
      if (outcome.status === 'FAILED') {
        requireThat(outcome.transactionHash === a.transactionHash, 'TRANSACTION_HASH_MISMATCH');
        a.status = 'failed'; a.failureCode = 'ON_CHAIN_FAILURE';
      } else if (a.prepared.expiresAt > Date.now()) {
        const wallet = (await this.store.allWallets()).find(w => w.id === a.walletId);
        requireThat(wallet, 'WALLET_NOT_FOUND', 404);
        validateIntent(a.intent, wallet);
        await this.policy(wallet, a.policy);
        await this.recipient(wallet, a.intent);
        // Replay only the identical durable bytes. No new nonce, signature or key.
        await this.chain.submit(a.signedXdr); a.status = 'pending'; a.failureCode = undefined;
      } else { a.failureCode = 'EXPIRED_OUTCOME_UNRESOLVED'; }
    } catch (error) { a.status = 'unknown'; a.failureCode = error instanceof PaymentError ? error.code : 'RPC_UNAVAILABLE'; }
    await this.store.finish(a, token); return a;
  }
  async tick() {
    for (const a of await this.store.unresolved()) {
      if (a.leaseUntil > Date.now()) continue;
      try {
        if (a.status === 'preparing') await this.prepare(a.id);
        else if (a.signedXdr) await this.reconcile(a.id);
        else if (a.prepared && a.prepared.expiresAt <= Date.now()) {
          const claimed = await this.store.claim(a.id, ['awaiting_approval', 'authorizing']);
          claimed.attempt.status = 'rejected'; claimed.attempt.failureCode = 'QUOTE_EXPIRED'; await this.store.finish(claimed.attempt, claimed.token);
        }
      } catch { /* Concurrent worker or unavailable dependency: retain durable state. */ }
    }
    await this.syncWallets?.();
    if(this.monitorWallets){await this.monitorWallets();return;}
    const cursor = await this.store.cursor();
    const page = await this.chain.events(cursor, this.startLedger);
    await this.store.ingest(page.events, cursor, page.cursor);
    for (const wallet of await this.store.allWallets()) {
      const balance = await this.chain.balance(wallet.address);
      await this.store.setBalance(wallet.address, balance.amountStroops, balance.ledger);
    }
  }
}
