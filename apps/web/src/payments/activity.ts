import { explorerLink, NETWORK, xlm, type Attempt } from './model';

export function filterActivity(items: Attempt[], address: string, direction: string, query: string) {
  const search = query.trim().toLowerCase();
  return items.filter(item => (direction === 'all' || (direction === 'sent' ? item.from === address : item.destination === address && item.from !== address)) && (!search || [item.id, item.transactionHash, item.from, item.destination, item.paymentRequestId].some(value => value?.toLowerCase().includes(search))));
}

export function activityCsv(items: Attempt[], address: string): string {
  const cell = (value: string) => `"${(/^[\s]*[=+\-@]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`;
  const rows = items.filter(i => i.network === NETWORK && (i.from === address || i.destination === address) && explorerLink(i));
  return [['transfer_id', 'network', 'transaction_hash', 'payment_request_id', 'date_utc', 'direction', 'from', 'to', 'amount_xlm'], ...rows.map(i => [i.id, i.network, i.transactionHash!, i.paymentRequestId ?? '', i.createdAt, i.from === address ? 'sent' : 'received', i.from, i.destination, xlm(i.amountStroops)])].map(row => row.map(cell).join(',')).join('\r\n');
}

export function downloadActivity(items: Attempt[], address: string) {
  const url = URL.createObjectURL(new Blob([activityCsv(items, address)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'cherry-wallet-testnet-transfers.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
