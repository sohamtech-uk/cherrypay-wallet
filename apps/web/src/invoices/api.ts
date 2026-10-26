import { Asset, Networks } from '@stellar/stellar-sdk';
import { object, text, type ApiClient } from '../payments/api';
import { addressKind, NETWORK, type Invoice, type InvoiceAdapter, type InvoiceDetail, type InvoiceReceipt } from '../payments/model';

const native=Asset.native().contractId(Networks.TESTNET);
const identifier=(v:unknown)=>{const s=text(v);if(!/^[a-f0-9-]{36}$/.test(s))throw Error('Invalid payment request ID.');return s;};
const exact=(v:unknown)=>{const s=text(v);if(!/^(0|[1-9][0-9]{0,39})$/.test(s))throw Error('Invalid invoice amount.');return s;};
const timestamp=(v:unknown)=>{if(!Number.isSafeInteger(v)||Number(v)<1)throw Error('Invalid invoice timestamp.');return Number(v);};
export function parseInvoice(value:unknown):Invoice {
  const r=object(value),amountStroops=exact(r.amountStroops),paidStroops=exact(r.paidStroops),remainingStroops=exact(r.remainingStroops);
  const amount=BigInt(amountStroops),paid=BigInt(paidStroops),remaining=amount>paid?amount-paid:0n;
  const status=paid===0n?'unpaid':paid<amount?'partially_paid':paid===amount?'paid':'overpaid';
  if(r.network!==NETWORK||r.asset!=='XLM'||r.assetContract!==native||addressKind(text(r.destination))!=='contract'||amount<=0n||amount>9223372036854775807n||remaining.toString()!==remainingStroops||r.status!==status||typeof r.expired!=='boolean'||typeof r.paymentPending!=='boolean'||!(/^[A-Za-z0-9][A-Za-z0-9 _./-]{0,63}$/.test(text(r.invoiceReference)))||text(r.merchantName).length>100)throw Error('Invalid invoice payment details.');
  return {id:identifier(r.id),network:NETWORK,asset:'XLM',assetContract:native,invoiceReference:text(r.invoiceReference),merchantName:text(r.merchantName),destination:text(r.destination),amountStroops,paidStroops,remainingStroops,status,expiresAt:timestamp(r.expiresAt),createdAt:timestamp(r.createdAt),expired:r.expired,paymentPending:r.paymentPending};
}
function receipt(value:unknown):InvoiceReceipt {
  const r=object(value),transactionHash=text(r.transactionHash),eventId=text(r.eventId),amountStroops=exact(r.amountStroops);
  if(!/^[a-f0-9]{64}$/.test(transactionHash)||!new RegExp(`^TESTNET:${transactionHash}:[0-9]+:[0-9]+$`).test(eventId)||!addressKind(text(r.from))||BigInt(amountStroops)<=0n)throw Error('Invalid invoice receipt.');
  return {eventId,transactionHash,from:text(r.from),amountStroops,ledger:timestamp(r.ledger),closedAt:timestamp(r.closedAt)};
}
export function invoiceAdapter(api:ApiClient,walletId:string,address:string):InvoiceAdapter {
  const base=`wallets/${encodeURIComponent(walletId)}/invoices`;
  function owned(value:unknown):InvoiceDetail {
    const r=object(value),invoice=parseInvoice(r);
    if(r.walletId!==walletId||invoice.destination!==address||!Array.isArray(r.receipts)||r.receipts.length>100||typeof r.receiptsTruncated!=='boolean')throw Error('Invoice wallet mismatch.');
    const receipts=r.receipts.map(value=>{const r=object(value),e=receipt(r);if(!['manual','checkout'].includes(text(r.method))||typeof r.late!=='boolean'||r.late!==(e.closedAt>invoice.expiresAt))throw Error('Invalid allocation.');return {...e,method:r.method as 'manual'|'checkout',actor:text(r.actor),note:text(r.note),allocatedAt:timestamp(r.allocatedAt),late:r.late};});
    if(new Set(receipts.map(r=>r.eventId)).size!==receipts.length||!r.receiptsTruncated&&receipts.reduce((n,r)=>n+BigInt(r.amountStroops),0n)!==BigInt(invoice.paidStroops))throw Error('Invoice receipt total mismatch.');
    return {...invoice,walletId,receipts,receiptsTruncated:r.receiptsTruncated};
  }
  return {
    async create(input) {const r=owned(await api(base,input));if(r.invoiceReference!==input.invoiceReference||r.merchantName!==input.merchantName||r.amountStroops!==input.amountStroops||r.expiresAt!==input.expiresAt)throw Error('Saved invoice differs from your request.');return r;},
    async get(id) {const r=owned(await api(`${base}/${encodeURIComponent(identifier(id))}`));if(r.id!==id)throw Error('Invoice identity mismatch.');return r;},
    async list(cursor) {const p=object(await api(`${base}${cursor?`?cursor=${encodeURIComponent(identifier(cursor))}`:''}`));if(p.network!==NETWORK||!Array.isArray(p.items)||p.items.length>20)throw Error('Invalid invoice list.');const items=p.items.map(parseInvoice);if(items.some(i=>i.destination!==address))throw Error('Invoice wallet mismatch.');return {items,nextCursor:p.nextCursor===undefined?undefined:identifier(p.nextCursor)};},
    async unmatched(cursor) {const p=object(await api(`wallets/${encodeURIComponent(walletId)}/unmatched-receipts${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`));if(p.network!==NETWORK||!Array.isArray(p.items)||p.items.length>20)throw Error('Invalid receipt list.');return {items:p.items.map(receipt),nextCursor:p.nextCursor===undefined?undefined:text(p.nextCursor)};},
    async allocate(id,eventId,note) {const r=owned(await api(`${base}/${encodeURIComponent(identifier(id))}/allocate`,{eventId,note}));if(r.id!==id||!r.receiptsTruncated&&!r.receipts.some(r=>r.eventId===eventId))throw Error('Allocation response mismatch.');return r;}
  };
}
