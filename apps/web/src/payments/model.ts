import { StrKey } from '@stellar/stellar-sdk';

export const NETWORK = 'TESTNET' as const;
const MAX = 9223372036854775807n;
export function stroops(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(value)) throw new Error('Enter XLM with up to 7 decimal places, without commas or exponents.');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 10000000n + BigInt(fraction.padEnd(7, '0'));
  if (amount > MAX) throw new Error('Amount exceeds the supported XLM limit.');
  return amount;
}
export function xlm(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error('Invalid amount from wallet service.');
  const amount = BigInt(value);
  return `${amount / 10000000n}.${(amount % 10000000n).toString().padStart(7, '0')}`;
}
export type RouteKind = 'classic' | 'contract';
export function addressKind(value: string): RouteKind | undefined {
  if (StrKey.isValidEd25519PublicKey(value)) return 'classic';
  if (StrKey.isValidContract(value)) return 'contract';
}
export function destinationError(value: string, supported: RouteKind[]): string {
  const kind = addressKind(value);
  if (!kind) return 'Enter a checksum-valid Stellar G-address or C-address. Muxed addresses, federation names and payment links are not supported.';
  return supported.includes(kind) ? '' : `Transfers to ${kind === 'contract' ? 'smart contracts' : 'classic accounts'} are not enabled by this wallet service.`;
}
export type Intent = { network: typeof NETWORK; from: string; destination: string; amountStroops: string; paymentRequestId?: string };
export type Quote = Intent & { id: string; feeStroops: string; feePayer: 'wallet' | 'sponsor'; spendableStroops: string; expiresAt: string };
export type AttemptStatus = 'awaiting_approval' | 'submitted' | 'pending' | 'unknown' | 'confirmed' | 'failed' | 'rejected';
export type Attempt = Intent & { id: string; status: AttemptStatus; createdAt: string; feeStroops: string; feeKnown?: boolean; transactionHash?: string; verified: boolean; failureMessage?: string };
export function checkQuote(quote: Quote, intent: Intent): void {
  if (!quote.id || quote.network !== NETWORK || quote.from !== intent.from || quote.destination !== intent.destination || quote.amountStroops !== intent.amountStroops || quote.paymentRequestId !== intent.paymentRequestId) throw new Error('The fee preview does not match this payment. Request a new preview.');
  if (!Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()) throw new Error('Fee preview expired. Request a new preview.');
  if (quote.feePayer !== 'wallet' && quote.feePayer !== 'sponsor') throw new Error('Unknown fee payer.');
  xlm(quote.feeStroops); xlm(quote.spendableStroops);
  if (BigInt(intent.amountStroops) + (quote.feePayer === 'wallet' ? BigInt(quote.feeStroops) : 0n) > BigInt(quote.spendableStroops)) throw new Error('Insufficient spendable XLM for this amount and fee. Reduce the amount or receive more Testnet XLM.');
}
export function statusLabel(attempt: Attempt): string {
  if (attempt.status === 'confirmed') return attempt.verified ? 'Confirmed and verified' : 'Awaiting verification';
  return { awaiting_approval: 'Awaiting approval', submitted: 'Submitted', pending: 'Pending confirmation', unknown: 'Outcome unknown — check status before retrying', failed: 'Failed', rejected: 'Approval rejected' }[attempt.status];
}
export function explorerLink(attempt: Attempt): string | undefined {
  return attempt.network === NETWORK && attempt.verified && attempt.status === 'confirmed' && /^[a-fA-F0-9]{64}$/.test(attempt.transactionHash ?? '') ? `https://stellar.expert/explorer/testnet/tx/${attempt.transactionHash}` : undefined;
}

/** Implement with authenticated, persistent B3–B6 services. No signing or fabricated transfers here. */
export interface PaymentAdapter {
  network: typeof NETWORK;
  address: string;
  supportedDestinations: RouteKind[];
  receive?: { address: string; route: RouteKind; instructions: string };
  canSign?: boolean;
  persistentPreview?: boolean;
  payroll?: PayrollAdapter;
  invoices?: InvoiceAdapter;
  getBalance?(): Promise<{ amountStroops: string; ledger: number; updatedAt: number } | null>;
  getQuote?(id: string): Promise<Quote>;
  cancelAttempt?(id: string): Promise<Attempt>;
  resetAttempt?(idempotencyKey:string):Promise<void>;
  listTransfers?(cursor?: string): Promise<{ items: Attempt[]; nextCursor?: string }>;
  prepare(intent: Intent, idempotencyKey?: string): Promise<Quote>;
  // Persist the attempt BEFORE requesting approval. Reusing the key MUST return the same attempt.
  createAttempt(quote: Quote, idempotencyKey: string): Promise<Attempt>;
  // Authorize the exact persisted intent, enforce quote expiry and submit at most once.
  approve(attemptId: string, reviewed?: Quote): Promise<Attempt>;
  getAttempt(id: string): Promise<Attempt>;
  getAttemptByKey(key: string): Promise<Attempt | null>;
  listAttempts(cursor?: string): Promise<{ items: Attempt[]; nextCursor?: string }>;
}

export type InvoiceInput = {network:'TESTNET';invoiceReference:string;merchantName:string;amountStroops:string;expiresAt:number};
export type Invoice = InvoiceInput & {id:string;asset:'XLM';assetContract:string;destination:string;paidStroops:string;remainingStroops:string;status:'unpaid'|'partially_paid'|'paid'|'overpaid';expired:boolean;paymentPending:boolean;createdAt:number};
export type InvoiceReceipt = {eventId:string;transactionHash:string;from:string;amountStroops:string;ledger:number;closedAt:number};
export type InvoiceDetail = Invoice & {walletId:string;receipts:(InvoiceReceipt & {method:'manual'|'checkout';actor:string;note:string;allocatedAt:number;late:boolean})[];receiptsTruncated:boolean};
export interface InvoiceAdapter {
  create(input:InvoiceInput):Promise<InvoiceDetail>;
  get(id:string):Promise<InvoiceDetail>;
  list(cursor?:string):Promise<{items:Invoice[];nextCursor?:string}>;
  unmatched(cursor?:string):Promise<{items:InvoiceReceipt[];nextCursor?:string}>;
  allocate(id:string,eventId:string,note:string):Promise<InvoiceDetail>;
}


export type PayRunInput = { network: 'TESTNET'; reference: string; maxFeeStroops: string; items: { reference: string; destination: string; amountStroops: string }[] };
export type PayRun = Omit<PayRunInput, 'items'> & { id: string; totalStroops: string; confirmedCount: number; status: 'draft' | 'in_progress' | 'completed'; items: (PayRunInput['items'][number] & { attempt: Attempt | null })[] };
export type PayRunSummary = { id: string; reference: string; createdAt: number; recipientCount: number };
export interface PayrollAdapter {
  create(input: PayRunInput): Promise<PayRun>;
  get(id: string): Promise<PayRun>;
  list(cursor?: string): Promise<{ items: PayRunSummary[]; nextCursor?: string }>;
  prepare(runId: string, reference: string): Promise<Attempt>;
}
