import { describe, it, expect, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { WalletBackendClient } from './wallet-backend.js';

describe('read-only Stellar Wallet Backend adapter', () => {
  const address=Keypair.random().publicKey();
  it('converts decimal XLM to stroops without floating point', async () => {
    const get=vi.fn(async () => new Response(JSON.stringify({data:{accountByAddress:{
      balances:{edges:[{node:{__typename:'NativeBalance',tokenType:'NATIVE',balance:'123456789.0000001'}}],pageInfo:{hasNextPage:false}},
      transactions:{edges:[{node:{hash:'a'.repeat(64),ledgerNumber:123,ledgerCreatedAt:'2026-10-25T10:00:00Z'}}],pageInfo:{startCursor:'opaque',hasPreviousPage:false}},
    }}}),{status:200,headers:{'Content-Type':'application/json'}}));
    const client=new WalletBackendClient('http://localhost:8001/graphql/query',get);
    expect(await client.account(address)).toEqual({
      address,nativeXlmStroops:'1234567890000001',transactions:[{hash:'a'.repeat(64),ledgerNumber:123,ledgerCreatedAt:'2026-10-25T10:00:00Z'}],
      previousCursor:'opaque',hasPreviousPage:false,balancesTruncated:false,
    });
    const args=JSON.parse((get.mock.calls[0] as any)[1].body);
    expect(args.variables.address).toBe(address);
  });
  it('fails closed on invalid or failed responses',async ()=>{
    const get=vi.fn(async () => new Response(JSON.stringify({errors:[{message:'failure'}]}),{status:200}));
    const client=new WalletBackendClient('http://localhost:8001/graphql/query',get);
    await expect(client.account(address)).rejects.toThrow('INDEXER_RESPONSE_UNVERIFIED');
    await expect(client.account('not an address')).rejects.toThrow('INVALID_STELLAR_ACCOUNT');
  });
  it('rejects untrusted insecure endpoint URLs',()=>{
    expect(()=>new WalletBackendClient('http://remote.example/graphql/query')).toThrow('INVALID_INDEXER_ENDPOINT');
  });
});

it('signs the exact request bytes using a short-lived, request-bound key', async () => {
  const { indexerToken } = await import('./wallet-backend.js');
  const key=Keypair.random(), body='{"query":"{ accountByAddress { address } }"}';
  const token=indexerToken(key,body,1234), [header,payload,signature]=token.split('.');
  expect(JSON.parse(Buffer.from(header,'base64url').toString())).toEqual({alg:'EdDSA',typ:'JWT'});
  expect(JSON.parse(Buffer.from(payload,'base64url').toString())).toMatchObject({iat:1234,exp:1244,sub:key.publicKey(),methodAndPath:'POST /graphql/query'});
  expect(key.verify(Buffer.from(`${header}.${payload}`),Buffer.from(signature,'base64url'))).toBe(true);
  expect(indexerToken(key,body+' ',1234)).not.toBe(token);
});
it('bounds the response body before parsing it',async()=>{
  const client=new WalletBackendClient('http://localhost:8001/graphql/query',async()=>new Response(' '.repeat(262145)));
  await expect(client.account(Keypair.random().publicKey())).rejects.toThrow('INDEXER_RESPONSE_TOO_LARGE');
});
