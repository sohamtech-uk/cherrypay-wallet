import { createHash } from 'node:crypto';
import { Asset, Networks, StrKey } from '@stellar/stellar-sdk';
export const NETWORK = 'TESTNET' as const;
export const PASSPHRASE = Networks.TESTNET;
export const NATIVE_SAC = Asset.native().contractId(PASSPHRASE);
export class PaymentError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
export function requireThat(value: unknown, code: string, status = 409): asserts value {
  if (!value) throw new PaymentError(code, status);
}
export function amount(value: string): bigint {
  requireThat(typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value), 'INVALID_STROOPS', 400);
  const parsed = BigInt(value);
  requireThat(parsed <= 9223372036854775807n, 'AMOUNT_OVERFLOW', 400);
  return parsed;
}
export type Wallet = { id: string; owner: string; address: string; policy: string; routes: ('classic' | 'contract')[]; createdAt: number };
export type Intent = { network: typeof NETWORK; destination: string; amountStroops: string; maxFeeStroops: string; paymentRequestId?: string };
export function validateIntent(intent: Intent, wallet: Wallet) {
  requireThat(intent.network === NETWORK, 'TESTNET_ONLY', 400);
  requireThat(intent.paymentRequestId === undefined || typeof intent.paymentRequestId === 'string' && /^[a-f0-9-]{36}$/.test(intent.paymentRequestId), 'INVALID_PAYMENT_REQUEST_ID', 400);
  amount(intent.amountStroops); amount(intent.maxFeeStroops);
  const route = StrKey.isValidEd25519PublicKey(intent.destination) ? 'classic' : StrKey.isValidContract(intent.destination) ? 'contract' : null;
  requireThat(route && wallet.routes.includes(route), 'UNSUPPORTED_DESTINATION', 400);
  requireThat(intent.destination !== wallet.address, 'SELF_TRANSFER_UNSUPPORTED', 400);
}
export function digest(intent: Intent): string {
  // Preserve existing digests for ordinary payments; invoice links are immutable as well.
  return createHash('sha256').update(JSON.stringify([intent.network, intent.destination, intent.amountStroops, intent.maxFeeStroops, ...(intent.paymentRequestId ? [intent.paymentRequestId] : [])])).digest('hex');
}
export type Status = 'preparing' | 'awaiting_approval' | 'authorizing' | 'ready' | 'pending' | 'unknown' | 'confirmed' | 'failed' | 'rejected';
export type Prepared = { transactionXdr: string; authXdr: string; feeStroops: string; expiresAt: number; expirationLedger: number; ledger: number };
export type Attempt = {
  id: string; walletId: string; idempotencyKey: string; requestDigest: string;
  intent: Intent; from: string; policy: string; status: Status;
  createdAt: number; updatedAt: number; prepared?: Prepared;
  signedXdr?: string; transactionHash?: string; verified: boolean; eventId?: string;
  failureCode?: string; leaseUntil: number; leaseToken?: string;
};
export const TERMINAL = ['confirmed', 'failed', 'rejected'];
export type TransferEvent = { id: string; transactionHash: string; ledger: number; operationIndex: number; eventIndex: number; from: string; to: string; amountStroops: string; closedAt: number };
export type Outcome = { status: 'NOT_FOUND' } | { status: 'FAILED'; transactionHash: string } | { status: 'SUCCESS'; transactionHash: string; events: TransferEvent[] };
export interface Chain {
  prepare(wallet: Wallet, intent: Intent): Promise<Prepared>;
  // Returns fee-only-relayer-signed bytes; never submits. The service durably persists them first.
  authorize(wallet: Wallet, intent: Intent, prepared: Prepared, authXdr: string): Promise<{ signedXdr: string; transactionHash: string }>;
  submit(signedXdr: string): Promise<void>;
  outcome(hash: string): Promise<Outcome>;
  balance(address: string): Promise<{ amountStroops: string; ledger: number }>;
  events(cursor: string | undefined, startLedger: number, address?: string): Promise<{ events: TransferEvent[]; cursor: string }>;
}
export interface PolicyReader {
  // Only a trusted adapter may establish spending readiness from current on-chain rules.
  // Recovery is a separate claim; legacy two-rule adapters retain their existing default.
  current(address: string): Promise<{ fingerprint: string; recoveryReady: boolean; spendingReady?: boolean }>;
}
export function spendingReady(policy: { recoveryReady: boolean; spendingReady?: boolean }) {
  return policy.spendingReady ?? policy.recoveryReady;
}
export function publicAttempt(a: Attempt) {
  return { id: a.id, walletId: a.walletId, from: a.from, ...a.intent,
    status: a.status, createdAt: new Date(a.createdAt).toISOString(), verified: a.verified,
    feeStroops: a.prepared?.feeStroops, feePayer: 'sponsor', transactionHash: a.transactionHash,
    eventId: a.eventId, failureCode: a.failureCode,
    approval: a.status === 'awaiting_approval' && a.prepared ? { authXdr: a.prepared.authXdr, expirationLedger: a.prepared.expirationLedger, expiresAt: new Date(a.prepared.expiresAt).toISOString() } : undefined,
    receipt: a.verified && a.transactionHash ? `https://stellar.expert/explorer/testnet/tx/${a.transactionHash}` : undefined };
}
