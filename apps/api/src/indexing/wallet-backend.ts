import { StrKey } from '@stellar/stellar-sdk';

/** Wallet Backend is an optional read-only indexer, never a payment authority. */
const QUERY = [
  'query CherryPayAccount($address: String!) {',
  ' accountByAddress(address: $address) {',
  '  balances(first: 100) { edges { node { __typename tokenType balance } } pageInfo { hasNextPage } }',
  '  transactions(last: 20) { edges { node { hash ledgerNumber ledgerCreatedAt } } pageInfo { startCursor hasPreviousPage } }',
  ' }',
  '}',
].join('\n');

function decimalToStroops(input: string): string {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(input);
  if(!match) throw Error('INVALID_INDEXED_XLM_BALANCE');
  return (BigInt(match[1])*10_000_000n + BigInt((match[2]??'').padEnd(7,'0'))).toString();
}
type BalanceNode = { __typename:string;tokenType:string;balance:string };
type TxNode = { hash:string;ledgerNumber:number;ledgerCreatedAt:string };
export type IndexedAccount = {
  address:string;
  nativeXlmStroops:string|null;
  transactions:TxNode[];
  previousCursor:string|null;
  hasPreviousPage:boolean;
  balancesTruncated:boolean;
};
/** Do not expose this method to unauthenticated requests: verify wallet ownership upstream. */
export class WalletBackendClient {
  private readonly endpoint: string;
  constructor(url:string,private readonly doFetch:typeof fetch = fetch) {
    const u = new URL(url);
    if(!((u.protocol==='http:' && ['localhost','127.0.0.1','host.docker.internal'].includes(u.hostname)) || u.protocol==='https:') || u.pathname!=='/graphql/query' || u.username || u.password || u.search || u.hash) {
      throw Error('INVALID_INDEXER_ENDPOINT');
    }
    this.endpoint=u.toString();
  }
  async account(address:string):Promise<IndexedAccount> {
    if(!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address))throw Error('INVALID_STELLAR_ACCOUNT');
    const resp=await this.doFetch(this.endpoint,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:QUERY,variables:{address}}),
      signal:AbortSignal.timeout(8000),
    });
    if(!resp.ok) throw Error('INDEXER_UNAVAILABLE');
    const payload = await resp.json() as {
      data?:{accountByAddress?:{
        balances?:{edges?:{node:BalanceNode}[];pageInfo?:{hasNextPage:boolean}};
        transactions?:{edges?:{node:TxNode}[];pageInfo?:{startCursor:string|null;hasPreviousPage:boolean}};
      }};
      errors?:unknown[];
    };
    if(payload.errors?.length || !payload.data?.accountByAddress)throw Error('INDEXER_RESPONSE_UNVERIFIED');
    const value=payload.data.accountByAddress;
    if(!value.balances?.edges || !value.balances.pageInfo || !value.transactions?.edges || !value.transactions.pageInfo)throw Error('INDEXER_RESPONSE_UNVERIFIED');
    const native=value.balances.edges.find(e=>e.node.__typename==='NativeBalance' && e.node.tokenType==='NATIVE');
    if(native && typeof native.node.balance !== 'string')throw Error('INDEXER_RESPONSE_UNVERIFIED');
    const tx=value.transactions.edges.map(e=>e.node);
    if(tx.some(t=>!/^[a-fA-F0-9]{64}$/.test(t.hash) || !Number.isSafeInteger(t.ledgerNumber) || t.ledgerNumber<=0 || typeof t.ledgerCreatedAt !== 'string'))throw Error('INDEXER_RESPONSE_UNVERIFIED');
    return {
      address,nativeXlmStroops:native?decimalToStroops(native.node.balance):null,
      transactions:tx,previousCursor:value.transactions.pageInfo.startCursor??null,
      hasPreviousPage:Boolean(value.transactions.pageInfo.hasPreviousPage),
      balancesTruncated:Boolean(value.balances.pageInfo.hasNextPage),
    };
  }
}
