import { createHash } from 'node:crypto';
import { Address, StrKey, xdr, type rpc } from '@stellar/stellar-sdk';
import { expect, it, vi } from 'vitest';
import { verifyCurrentContractCode } from './receive-route.js';
import { KNOWN_UNSAFE_ACCOUNT_WASM } from './kit-manifest.js';
const address=StrKey.encodeContract(Buffer.alloc(32,1));
function fixture(){
  const bytes=Buffer.from('test-wasm-bytes'),hash=createHash('sha256').update(bytes).digest('hex');
  const contract=Address.fromString(address).toScAddress();
  const instanceKey=xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({contract,key:xdr.ScVal.scvLedgerKeyContractInstance(),durability:xdr.ContractDataDurability.persistent()}));
  const codeKey=xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({hash:Buffer.from(hash,'hex')}));
  const entries:rpc.Api.LedgerEntryResult[]=[
    {key:instanceKey,liveUntilLedgerSeq:2000,val:xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({ext:new xdr.ExtensionPoint(0),contract,key:xdr.ScVal.scvLedgerKeyContractInstance(),durability:xdr.ContractDataDurability.persistent(),val:xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({executable:xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hash,'hex')),storage:[]}))}))},
    {key:codeKey,liveUntilLedgerSeq:2000,val:xdr.LedgerEntryData.contractCode(new xdr.ContractCodeEntry({ext:new xdr.ContractCodeEntryExt(0),hash:Buffer.from(hash,'hex'),code:bytes}))},
  ];
  return {hash,entries,server:{getNetwork:vi.fn(async()=>({passphrase:'Test SDF Network ; September 2015',protocolVersion:'23'})),getLedgerEntries:vi.fn(async()=>({entries,latestLedger:1000}))}};
}
it('checks instance, exact code bytes, network and TTL independently',async()=>{const f=fixture();expect(await verifyCurrentContractCode(f.server,address,f.hash)).toMatchObject({ledger:1000,wasmHash:f.hash});f.entries[1].val.contractCode().code(Buffer.from('tampered'));await expect(verifyCurrentContractCode(f.server,address,f.hash)).rejects.toThrow('WASM_BYTES_MISMATCH');});
it('rejects unavailable/expiring code and a different network',async()=>{const f=fixture();f.entries[0].liveUntilLedgerSeq=1010;await expect(verifyCurrentContractCode(f.server,address,f.hash)).rejects.toThrow('TTL');f.server.getNetwork.mockResolvedValue({passphrase:'Public Global Stellar Network ; September 2015',protocolVersion:'23'});await expect(verifyCurrentContractCode(f.server,address,f.hash)).rejects.toThrow('NETWORK');});
it('blocks the legacy artifact before making any RPC request',async()=>{const f=fixture();await expect(verifyCurrentContractCode(f.server,address,KNOWN_UNSAFE_ACCOUNT_WASM)).rejects.toThrow('KNOWN_UNSAFE');expect(f.server.getNetwork).not.toHaveBeenCalled();});
