import { startAuthentication } from '@simplewebauthn/browser';
import { invoiceAdapter } from '../invoices/api';
import { addressKind, checkQuote, destinationError, NETWORK, type Attempt, type AttemptStatus, type Intent, type PaymentAdapter, type Quote, type RouteKind, type PayRun, type PayRunInput } from './model';

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(status === 401 ? 'Your session expired. Reconnect with your passkey.' : status === 503 ? 'The payment service is unavailable or not yet enabled. Check existing attempts before retrying.' : `Wallet request could not complete (${code}).`);
  }
}
export function apiClient(token: () => string | undefined, transport: typeof fetch = fetch) {
  return async (path: string, body?: unknown, headers?: Record<string, string>): Promise<unknown> => {
    const session = token();
    const response = await transport(`/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { ...(session ? { Authorization: `Bearer ${session}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const code = data && typeof data.error === 'string' && /^[A-Z_]{1,80}$/.test(data.error) ? data.error : 'REQUEST_FAILED';
      throw new ApiError(response.status, code);
    }
    return response.status === 204 ? undefined : response.json();
  };
}
export type ApiClient = ReturnType<typeof apiClient>;
export type OwnedWallet = {id:string;address:string};
export async function discoverWallets(api:ApiClient):Promise<OwnedWallet[]> {
  const page=object(await api('wallets'));
  if(page.network!==NETWORK || !Array.isArray(page.items) || page.items.length>100) throw Error('Invalid wallet discovery response.');
  const items=page.items.map(value=>{
    const wallet=object(value),id=text(wallet.id),address=text(wallet.address);
    if(wallet.network!==NETWORK || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || addressKind(address)!=='contract') throw Error('Invalid owned wallet.');
    return {id,address};
  });
  if(new Set(items.map(w=>w.id)).size!==items.length || new Set(items.map(w=>w.address)).size!==items.length) throw Error('Duplicate wallet identity.');
  return items;
}
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid wallet service response.'); return value as Record<string, unknown>; }
export function text(value: unknown): string { if (typeof value !== 'string' || !value.length) throw Error('Invalid wallet service response.'); return value; }
function integer(value: unknown): string { const s = text(value); if (!/^(0|[1-9]\d{0,18})$/.test(s) || BigInt(s) > 9223372036854775807n) throw Error('Invalid exact amount.'); return s; }
function date(value: unknown): string { const s = text(value); if (!Number.isFinite(Date.parse(s))) throw Error('Invalid wallet timestamp.'); return s; }
function hash(value: unknown): string | undefined { if (value === undefined) return; const s = text(value); if (!/^[a-f0-9]{64}$/.test(s)) throw Error('Invalid transaction hash.'); return s; }
function cursor(value: unknown): string | undefined { if (value === undefined) return; const s = text(value); if (s.length > 512) throw Error('Invalid history cursor.'); return s; }
const statuses: Record<string, AttemptStatus> = { preparing: 'pending', awaiting_approval: 'awaiting_approval', authorizing: 'pending', ready: 'pending', pending: 'pending', unknown: 'unknown', confirmed: 'confirmed', failed: 'failed', rejected: 'rejected' };
export type TransferApproval = { attemptId: string; walletId: string; intent: Intent; feeStroops: string; authXdr: string; expiresAt: string; expirationLedger: number };
/** B2 must validate and sign this exact Soroban authorization, never a login challenge. */
export type TransferSigner = (approval: TransferApproval) => Promise<string>;
export async function connectPaymentAdapter(api: ApiClient, walletId: string, signer?: TransferSigner, authenticate = startAuthentication): Promise<PaymentAdapter> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(walletId)) throw Error('Enter a valid wallet ID.');
  const base = `wallets/${encodeURIComponent(walletId)}`;
  const wallet = object(await api(base));
  if (wallet.network !== NETWORK || wallet.id !== walletId || !addressKind(text(wallet.address))) throw Error('Wallet identity or Testnet network mismatch.');
  const address = text(wallet.address);
  if (!Array.isArray(wallet.supportedDestinations) || wallet.supportedDestinations.some(x => x !== 'classic' && x !== 'contract')) throw Error('Invalid destination policy.');
  const supportedDestinations = wallet.supportedDestinations as RouteKind[];
  const parse = (input: unknown): Attempt => {
    const a = object(input);
    if (a.walletId !== walletId || a.network !== NETWORK || a.from !== address || !addressKind(text(a.destination)) || typeof a.verified !== 'boolean' || typeof a.status !== 'string' || !Object.hasOwn(statuses, a.status)) throw Error('Payment does not match this wallet or network.');
    const transactionHash = hash(a.transactionHash);
    if (a.verified && (a.status !== 'confirmed' || !transactionHash)) throw Error('Invalid verified payment.');
    const paymentRequestId=a.paymentRequestId===undefined?undefined:text(a.paymentRequestId);
    if(paymentRequestId!==undefined&&!/^[a-f0-9-]{36}$/.test(paymentRequestId))throw Error('Invalid invoice payment reference.');
    return { id: text(a.id), network: NETWORK, from: address, destination: text(a.destination), amountStroops: integer(a.amountStroops), ...(paymentRequestId?{paymentRequestId}:{}), feeStroops: a.feeStroops === undefined ? '0' : integer(a.feeStroops), feeKnown: a.feeStroops !== undefined, createdAt: date(a.createdAt), status: statuses[a.status], verified: a.verified, transactionHash, failureMessage: a.failureCode ? 'Payment could not complete. Check its status before starting another payment.' : undefined };
  };
  const read = async (id: string) => { const raw = await api(`${base}/attempts/${encodeURIComponent(id)}`); const a = parse(raw); if (a.id !== id) throw Error('Attempt identity mismatch.'); return { raw: object(raw), attempt: a }; };
  const balance = async () => {
    const data = object(await api(`${base}/balance`));
    if (data.network !== NETWORK || data.address !== address) throw Error('Balance wallet mismatch.');
    if (data.snapshot === null) return null;
    const snapshot = object(data.snapshot);
    if (!Number.isSafeInteger(snapshot.ledger) || Number(snapshot.ledger) <= 0 || !Number.isSafeInteger(snapshot.updatedAt)) throw Error('Invalid balance snapshot.');
    return { amountStroops: integer(snapshot.amountStroops), ledger: Number(snapshot.ledger), updatedAt: Number(snapshot.updatedAt) };
  };
  const quoteFor = async (raw: Record<string, unknown>): Promise<Quote> => {
    const a = parse(raw); if (a.status !== 'awaiting_approval' || raw.feePayer !== 'sponsor' || !a.feeKnown) throw Error('This attempt is not ready for approval. Check its status.');
    const approval = object(raw.approval);
    const snapshot = await balance();
    if (!snapshot || Date.now() - snapshot.updatedAt > 60000 || snapshot.updatedAt > Date.now() + 5000) throw Error('A recent indexed balance is not available. Refresh before approving.');
    const q: Quote = { ...a, feePayer: 'sponsor', spendableStroops: snapshot.amountStroops, expiresAt: date(approval.expiresAt) };
    checkQuote(q, a); return q;
  };
  const adapter: PaymentAdapter = {
    network: NETWORK, address, supportedDestinations, canSign: !!signer || wallet.approvalMode === 'webauthn', persistentPreview: true,
    getBalance: balance,
    async prepare(intent, key) {
      if (!signer && wallet.approvalMode !== 'webauthn') throw Error('Transaction signing is not connected.');
      if (!key) throw Error('A saved recovery key is required before preparation.');
      if (intent.network !== NETWORK || intent.from !== address || destinationError(intent.destination, supportedDestinations) || intent.destination === address || BigInt(integer(intent.amountStroops)) <= 0n) throw Error('Unsupported payment intent.');
      const raw = object(await api(`${base}/attempts`, { network: NETWORK, destination: intent.destination, amountStroops: intent.amountStroops, maxFeeStroops: '10000000', ...(intent.paymentRequestId?{paymentRequestId:intent.paymentRequestId}:{}) }, { 'Idempotency-Key': key }));
      const q = await quoteFor(raw); checkQuote(q, intent); return q;
    },
    async createAttempt(quote, key) {
      // Preparation already persisted the attempt. Never POST a replacement here.
      const found = await adapter.getAttemptByKey(key);
      if (!found || found.id !== quote.id || found.destination !== quote.destination || found.amountStroops !== quote.amountStroops || found.feeStroops !== quote.feeStroops || found.paymentRequestId!==quote.paymentRequestId) throw Error('Stored attempt differs from the reviewed payment.');
      return found;
    },
    async approve(id, reviewed) {
      if ((!signer && wallet.approvalMode !== 'webauthn') || !reviewed) throw Error('A transaction signer and reviewed payment are required.');
      const { raw, attempt } = await read(id);
      const q = await quoteFor(raw); checkQuote(q, reviewed);
      if (reviewed.id !== id || reviewed.feeStroops !== q.feeStroops || reviewed.expiresAt !== q.expiresAt || reviewed.feePayer !== q.feePayer) throw Error('Payment preview changed. Review the existing attempt again.');
      const approval = object(raw.approval);
      if (!Number.isSafeInteger(approval.expirationLedger) || Number(approval.expirationLedger) <= 0) throw Error('Invalid authorization expiration.');
      if (wallet.approvalMode === 'webauthn') {
        const begin = object(await api(`${base}/attempts/${encodeURIComponent(id)}/approval/options`, {}));
        const offered = object(begin.attempt), offeredAttempt = parse(offered);
        const offeredApproval = object(offered.approval);
        if (offeredAttempt.id !== id || offeredAttempt.destination !== reviewed.destination || offeredAttempt.amountStroops !== reviewed.amountStroops || offeredAttempt.paymentRequestId!==reviewed.paymentRequestId || offeredAttempt.feeStroops !== reviewed.feeStroops || offeredAttempt.status !== 'awaiting_approval' || offeredApproval.authXdr !== approval.authXdr || offeredApproval.expiresAt !== q.expiresAt || Date.parse(date(begin.expiresAt)) <= Date.now()) throw Error('Approval challenge differs from the reviewed payment.');
        const options = object(begin.options);
        if (options.userVerification !== 'required' || !/^[A-Za-z0-9_-]{43}$/.test(text(options.challenge)) || !Array.isArray(options.allowCredentials) || options.allowCredentials.length === 0) throw Error('Invalid transfer approval options.');
        const response = await authenticate({ optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
        checkQuote(q, reviewed);
        const result = parse(await api(`${base}/attempts/${encodeURIComponent(id)}/approval/verify`, { requestID: text(begin.requestID), response }));
        if (result.id !== id || result.destination !== reviewed.destination || result.amountStroops !== reviewed.amountStroops || result.paymentRequestId!==reviewed.paymentRequestId) throw Error('Approval response mismatch. Check existing attempt.');
        return result;
      }
      const authXdr = await signer!({ attemptId: id, walletId, intent: { network: NETWORK, from: address, destination: attempt.destination, amountStroops: attempt.amountStroops }, feeStroops: q.feeStroops, authXdr: text(approval.authXdr), expiresAt: q.expiresAt, expirationLedger: Number(approval.expirationLedger) });
      checkQuote(q, reviewed);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(authXdr) || authXdr.length > 16000) throw Error('Invalid signed authorization.');
      const result = parse(await api(`${base}/attempts/${encodeURIComponent(id)}/approve`, { authXdr }));
      if (result.id !== id || result.destination !== attempt.destination || result.amountStroops !== attempt.amountStroops || result.paymentRequestId!==attempt.paymentRequestId) throw Error('Approval response mismatch. Check existing attempt.');
      return result;
    },
    async getAttempt(id) { return (await read(id)).attempt; },
    async getQuote(id) { return quoteFor((await read(id)).raw); },
    async cancelAttempt(id) { const a = parse(await api(`${base}/attempts/${encodeURIComponent(id)}/cancel`, {})); if (a.id !== id) throw Error('Attempt identity mismatch.'); return a; },
    async resetAttempt(key) {
      if(!/^[A-Za-z0-9_-]{16,128}$/.test(key))throw Error('Invalid saved payment key.');
      let result:Record<string,unknown>;
      try {result=object(await api(`${base}/attempt-by-key/${encodeURIComponent(key)}/reset`,{}));}
      catch {throw Error('Reset could not be confirmed. A payment may be processing or submitted. Check the existing attempt before trying again.');}
      if(result.network!==NETWORK||result.walletId!==walletId||result.key!==key||result.reset!==true||!['not_created','cancelled','rejected','failed','confirmed'].includes(String(result.outcome)))throw Error('Invalid reset confirmation. Keep the existing payment record.');
      if(result.outcome!=='not_created'){
        const a=parse(result.attempt);
        if(!['rejected','failed'].includes(a.status)&&!(a.status==='confirmed'&&a.verified))throw Error('Payment outcome is still unresolved.');
      }else if(result.attempt!==undefined)throw Error('Invalid reset confirmation.');
    },
    async getAttemptByKey(key) { try { return parse(await api(`${base}/attempt-by-key/${encodeURIComponent(key)}`)); } catch (e) { if (e instanceof ApiError && e.status === 404 && e.code === 'ATTEMPT_NOT_FOUND') return null; throw e; } },
    async listAttempts(next) { const data = object(await api(`${base}/attempts${next ? `?cursor=${encodeURIComponent(next)}` : ''}`)); if (!Array.isArray(data.items)) throw Error('Invalid history.'); return { items: data.items.map(parse), nextCursor: cursor(data.nextCursor) }; },
    async listTransfers(next) {
      const data = object(await api(`${base}/history${next ? `?cursor=${encodeURIComponent(next)}` : ''}`));
      if (data.network !== NETWORK || !Array.isArray(data.items)) throw Error('Invalid indexed history.');
      const items = data.items.map(value => {
        const e = object(value), transactionHash = hash(e.transactionHash);
        if (e.verified !== true || !transactionHash || (e.from !== address && e.to !== address) || !addressKind(text(e.from)) || !addressKind(text(e.to)) || !Number.isSafeInteger(e.closedAt) || !Number.isSafeInteger(e.operationIndex) || !Number.isSafeInteger(e.eventIndex) || Number(e.operationIndex)<0 || Number(e.eventIndex)<0 || e.id !== `TESTNET:${transactionHash}:${e.operationIndex}:${e.eventIndex}`) throw Error('Invalid verified event.');
        return { id: text(e.id), network: NETWORK, from: text(e.from), destination: text(e.to), amountStroops: integer(e.amountStroops), feeStroops: '0', feeKnown: false, createdAt: new Date(Number(e.closedAt)).toISOString(), status: 'confirmed' as const, verified: true, transactionHash };
      });
      return { items, nextCursor: cursor(data.nextCursor) };
    },
  };
  adapter.invoices=invoiceAdapter(api,walletId,address);
  const runReference = (value: unknown) => { const s = text(value); if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s)) throw Error('Invalid pay run reference.'); return s; };
  const parseRun = (value: unknown): PayRun => {
    const r = object(value);
    if (r.walletId !== walletId || r.network !== NETWORK || !Array.isArray(r.items) || r.items.length < 1 || r.items.length > 50 || !['draft','in_progress','completed'].includes(text(r.status))) throw Error('Pay run wallet or network mismatch.');
    const items = r.items.map(value => {
      const row = object(value), destination = text(row.destination), amountStroops = integer(row.amountStroops);
      if (!addressKind(destination) || destination === address || BigInt(amountStroops) <= 0n) throw Error('Invalid pay run recipient or amount.');
      const attempt = row.attempt === null ? null : parse(row.attempt);
      if (attempt && (attempt.destination !== destination || attempt.amountStroops !== amountStroops || object(row.attempt).maxFeeStroops !== r.maxFeeStroops)) throw Error('Pay run payment mismatch.');
      return { reference: runReference(row.reference), destination, amountStroops, attempt };
    });
    const confirmed = items.filter(i => i.attempt?.status === 'confirmed' && i.attempt.verified).length;
    const totalStroops = integer(r.totalStroops), maxFeeStroops = integer(r.maxFeeStroops);
    const status = confirmed === items.length ? 'completed' : items.some(i => i.attempt) ? 'in_progress' : 'draft';
    if (new Set(items.map(i => i.reference)).size !== items.length || new Set(items.map(i => i.destination)).size !== items.length || items.reduce((n,i) => n + BigInt(i.amountStroops),0n).toString() !== totalStroops || confirmed !== r.confirmedCount || r.status !== status || BigInt(maxFeeStroops) <= 0n || BigInt(maxFeeStroops) > 10000000n) throw Error('Pay run totals or status mismatch.');
    return { id: text(r.id), reference: runReference(r.reference), network: NETWORK, items, maxFeeStroops, totalStroops, confirmedCount: confirmed, status };
  };
  adapter.payroll = {
    async create(input: PayRunInput) {
      const run = parseRun(await api(`${base}/payroll`, input));
      if (run.reference !== input.reference || run.maxFeeStroops !== input.maxFeeStroops || JSON.stringify(run.items.map(({ reference,destination,amountStroops }) => [reference,destination,amountStroops])) !== JSON.stringify(input.items.map(i => [i.reference,i.destination,i.amountStroops]))) throw Error('Saved pay run differs from your request. Refresh existing runs.');
      return run;
    },
    async get(id) { const run = parseRun(await api(`${base}/payroll/${encodeURIComponent(id)}`)); if (run.id !== id) throw Error('Pay run identity mismatch.'); return run; },
    async list(next) {
      const data = object(await api(`${base}/payroll${next ? `?cursor=${encodeURIComponent(next)}` : ''}`));
      if (data.network !== NETWORK || !Array.isArray(data.items) || data.items.length > 20) throw Error('Invalid pay run list.');
      return { items: data.items.map(value => {
        const row = object(value);
        if (!Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.recipientCount) || Number(row.recipientCount) < 1 || Number(row.recipientCount) > 50) throw Error('Invalid pay run summary.');
        return { id: text(row.id), reference: runReference(row.reference), createdAt: Number(row.createdAt), recipientCount: Number(row.recipientCount) };
      }), nextCursor: cursor(data.nextCursor) };
    },
    async prepare(runId, reference) { return parse(await api(`${base}/payroll/${encodeURIComponent(runId)}/lines/${encodeURIComponent(reference)}/prepare`, {})); },
  };
  // Outbound destination policy is NOT proof of a supported receive route.
  if (wallet.receive !== undefined) {
    const receive = object(wallet.receive);
    if (receive.address !== address || receive.route !== addressKind(address)) throw Error('Receive route mismatch.');
    adapter.receive = { address, route: receive.route as RouteKind, instructions: text(receive.instructions) };
  }
  return adapter;
}
