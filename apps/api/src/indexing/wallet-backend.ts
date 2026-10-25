import { createHash } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

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
  const match = /^(\d{1,32})(?:\.(\d{1,7}))?$/.exec(input);
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
  constructor(url:string,private readonly doFetch:typeof fetch = fetch, private readonly signer?: Keypair) {
    const u = new URL(url);
    if(!((u.protocol==='http:' && ['localhost','127.0.0.1','host.docker.internal'].includes(u.hostname)) || u.protocol==='https:') || u.pathname!=='/graphql/query' || u.username || u.password || u.search || u.hash) {
      throw Error('INVALID_INDEXER_ENDPOINT');
    }
    this.endpoint=u.toString();
  }
  async account(address:string):Promise<IndexedAccount> {
    if(!StrKey.isValidEd25519PublicKey(address) && !StrKey.isValidContract(address))throw Error('INVALID_STELLAR_ACCOUNT');
    const body = JSON.stringify({query:QUERY,variables:{address}});
    const headers: Record<string,string> = {'Content-Type':'application/json'};
    if (this.signer) headers.Authorization = `Bearer ${indexerToken(this.signer, body)}`;
    const resp=await this.doFetch(this.endpoint,{
      method:'POST',headers,body,redirect:'error',
      signal:AbortSignal.timeout(8000),
    });
    if(!resp.ok) throw Error('INDEXER_UNAVAILABLE');
    const payload = await boundedJson(resp) as {
      data?:{accountByAddress?:{
        balances?:{edges?:{node:BalanceNode}[];pageInfo?:{hasNextPage:boolean}};
        transactions?:{edges?:{node:TxNode}[];pageInfo?:{startCursor:string|null;hasPreviousPage:boolean}};
      }};
      errors?:unknown[];
    };
    if(payload.errors?.length || !payload.data?.accountByAddress)throw Error('INDEXER_RESPONSE_UNVERIFIED');
    const value=payload.data.accountByAddress;
    if(!value.balances?.edges || !value.balances.pageInfo || !value.transactions?.edges || !value.transactions.pageInfo)throw Error('INDEXER_RESPONSE_UNVERIFIED');
    if (!Array.isArray(value.balances.edges) || value.balances.edges.length > 100 || !Array.isArray(value.transactions.edges) || value.transactions.edges.length > 20 || typeof value.balances.pageInfo.hasNextPage !== 'boolean' || typeof value.transactions.pageInfo.hasPreviousPage !== 'boolean' || (value.transactions.pageInfo.startCursor !== null && (typeof value.transactions.pageInfo.startCursor !== 'string' || value.transactions.pageInfo.startCursor.length > 512))) throw Error('INDEXER_RESPONSE_UNVERIFIED');
    const native=value.balances.edges.find(e=>e.node.__typename==='NativeBalance' && e.node.tokenType==='NATIVE');
    if(native && typeof native.node.balance !== 'string')throw Error('INDEXER_RESPONSE_UNVERIFIED');
    const tx=value.transactions.edges.map(e=>e.node);
    if(tx.some(t=>!/^[a-fA-F0-9]{64}$/.test(t.hash) || !Number.isSafeInteger(t.ledgerNumber) || t.ledgerNumber<=0 || typeof t.ledgerCreatedAt !== 'string' || !Number.isFinite(Date.parse(t.ledgerCreatedAt))))throw Error('INDEXER_RESPONSE_UNVERIFIED');
    return {
      address,nativeXlmStroops:native?decimalToStroops(native.node.balance):null,
      transactions:tx,previousCursor:value.transactions.pageInfo.startCursor??null,
      hasPreviousPage:Boolean(value.transactions.pageInfo.hasPreviousPage),
      balancesTruncated:Boolean(value.balances.pageInfo.hasNextPage),
    };
  }
}

/** Wallet Backend request-bound EdDSA JWT; never a transaction signing key. */
export function indexerToken(signer: Keypair, body: string, now = Math.floor(Date.now()/1000)) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = part({bodyHash:createHash('sha256').update(body).digest('hex'),exp:now+10,iat:now,methodAndPath:'POST /graphql/query',sub:signer.publicKey()});
  const input = `${part({alg:'EdDSA',typ:'JWT'})}.${payload}`;
  return `${input}.${signer.sign(Buffer.from(input)).toString('base64url')}`;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw Error('INDEXER_RESPONSE_UNVERIFIED');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 262144) { await reader.cancel(); throw Error('INDEXER_RESPONSE_TOO_LARGE'); }
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}
