import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { PostgresApprovalTickets, postgresAssertionVerifier } from './payments/passkey-approval.js';
import { hashToken } from './store.js';
import { buildApp } from './app.js';
import { getConfig } from './config.js';
import { PaymentService } from './payments/service.js';
import { mockChain, mockPolicy } from './payments/test-fixtures.js';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, initializeStore, createAccount, createSession, sessionAccount, revokeSession, newChallenge, withLockedAccount, consumeLockedChallenge, credentialsLocked, addCredentialLocked } from './store.js';
import { PostgresPaymentRepository } from './payments/postgres-repository.js';
import { type Intent, type TransferEvent, type Wallet } from './payments/model.js';
import { provisionAccounts } from './smart-account/provision.js';
import { manifestFixture } from './smart-account/test-support/manifest.js';
import { testPasskey } from './test-passkey.js';
import { StrKey } from '@stellar/stellar-sdk';

const integration = process.env.RUN_DB_INTEGRATION==='1' ? describe : describe.skip;
integration('PostgreSQL wallet integration and transaction invariants', () => {
  const repository = new PostgresPaymentRepository(db);
  let account: {id:string};
  let wallet: Wallet;
  beforeAll(async () => {
    await initializeStore();
    // Re-running checksum-validated migrations must be a no-op.
    await initializeStore();
    account=await createAccount(`${randomUUID()}@example.com`);
    wallet={id:randomUUID(),owner:account.id,address:'C'+'B'.repeat(55),policy:'testnet-policy',routes:['classic'],createdAt:Date.now()};
    await db.query("INSERT INTO wallet_onchain_accounts(id,owner,network,address,policy,routes,created_at) VALUES ($1,$2,'TESTNET',$3,$4,$5::jsonb,$6)",[wallet.id,wallet.owner,wallet.address,wallet.policy,JSON.stringify(wallet.routes),wallet.createdAt]);
  },30_000);
  it('applies identity and payment migrations only once',async () => {
    const {rows}=await db.query('SELECT name FROM wallet_schema_migrations ORDER BY name');
    expect(rows.map(r=>r.name)).toEqual(['001_wallet_identity.sql','002_wallet_payments.sql','003_transfer_approvals.sql','004_email_identity.sql','004_payroll_runs.sql','009_wallet_deployment_jobs.sql','010_automatic_contract_deployment.sql']);
  });
  it('persists and revokes hashed sessions',async () => {
    const {token}=await createSession(account.id);
    expect(await sessionAccount(token)).toEqual(account.id);
    const result=await db.query('SELECT token_hash FROM wallet_sessions WHERE account_id=$1',[account.id]);
    expect(result.rows[0].token_hash).not.toEqual(token);
    await revokeSession(token);
    expect(await sessionAccount(token)).toBeNull();
  });
  it('keeps legacy UUID sessions valid without presenting their ID as an email',async()=>{
    const owner=randomUUID();
    await db.query('INSERT INTO wallet_accounts(id,webauthn_user_id) VALUES($1,$2)',[owner,randomUUID()]);
    const session=await createSession(owner);
    const app=await buildApp({config:getConfig({WALLET_ORIGIN:'https://wallet.example'}),logger:false});
    try {
      const me=await app.inject({url:'/api/v1/wallet/me',headers:{authorization:`Bearer ${session.token}`}});
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({accountID:owner,email:null,emailVerified:false,walletDeploymentEnabled:false});
    } finally {await revokeSession(session.token);await app.close();}
  });
  it('consumes a challenge once and serializes first-credential ownership',async () => {
    const requestId=await newChallenge(account.id,'register_initial','challenge');
    expect(await withLockedAccount(account.id,c=>consumeLockedChallenge(c,requestId,account.id,'register_initial'))).toBe('challenge');
    await expect(withLockedAccount(account.id,c=>consumeLockedChallenge(c,requestId,account.id,'register_initial'))).rejects.toThrow();
    const enroll=async (id:string) => withLockedAccount(account.id,async c => {
      const stored=await credentialsLocked(c,account.id);
      if(stored.length) throw Error('Already enrolled');
      await addCredentialLocked(c,account.id,{id,publicKey:new Uint8Array([1,2,3]),counter:0,transports:['internal']});
    });
    const result=await Promise.allSettled([enroll('pk-'+randomUUID()),enroll('pk-'+randomUUID())]);
    expect(result.filter(x=>x.status==='fulfilled')).toHaveLength(1);
    expect(result.filter(x=>x.status==='rejected')).toHaveLength(1);
    const {rows}=await db.query('SELECT count(*)::int AS total FROM wallet_credentials WHERE account_id=$1',[account.id]);
    expect(rows[0].total).toBe(1);
  });
  it('enrolls primary and additional passkeys through HTTP with session-bound challenges and real verification',async()=>{
    const app=await buildApp({config:getConfig({WALLET_ORIGIN:'https://wallet.example'}),logger:false});
    const post=(path:string,payload:Record<string,unknown>,token?:string)=>app.inject({method:'POST',url:`/api/v1/${path}`,headers:{origin:'https://wallet.example',...(token?{authorization:`Bearer ${token}`}:{})},payload});
    try {
      const primary=testPasskey(),backup=testPasskey();
      const initial=(await post('passkeys/registration/options',{email:`${randomUUID()}@example.com`})).json();
      expect(initial.options.pubKeyCredParams).toEqual([{alg:-7,type:'public-key'}]);
      const enrolled=await post('passkeys/registration/verify',{accountID:initial.accountID,requestID:initial.requestID,response:primary.registration(initial.options.challenge)});
      expect(enrolled.statusCode).toBe(200);const first=enrolled.json();
      expect(first).toMatchObject({verified:true,credentialCount:1,recoveryReady:false});
      expect((await post('passkeys/registration/options',{accountID:first.accountID})).statusCode).toBe(403);
      const second=(await post('passkeys/registration/options',{accountID:first.accountID},first.token)).json();
      expect(second.options.excludeCredentials.map((c:{id:string})=>c.id)).toContain(primary.id);
      const payload={accountID:first.accountID,requestID:second.requestID,response:backup.registration(second.options.challenge)};
      const otherSession=await createSession(first.accountID);
      expect((await post('passkeys/registration/verify',payload,otherSession.token)).statusCode).toBe(400);
      const foreign=await createAccount(`${randomUUID()}@example.com`),foreignSession=await createSession(foreign.id);
      expect((await post('passkeys/registration/verify',payload,foreignSession.token)).statusCode).toBe(403);
      const added=await post('passkeys/registration/verify',payload,first.token);
      expect(added.statusCode).toBe(200);const next=added.json();
      expect(next).toMatchObject({credentialCount:2,backupCredentialEnrolled:true,recoveryReady:false});
      expect((await post('passkeys/registration/verify',payload,first.token)).statusCode).toBe(400);
      await post('session/logout',{},first.token);
      expect(await sessionAccount(first.token)).toBeNull();expect(await sessionAccount(next.token)).toBe(first.accountID);
      // The new credential really works for sign-in, without claiming on-chain recovery.
      const login=(await post('passkeys/authentication/options',{accountID:first.accountID})).json();
      const signedIn=await post('passkeys/authentication/verify',{accountID:first.accountID,requestID:login.requestID,response:backup.authentication(login.options.challenge)});
      expect(signedIn.statusCode).toBe(200);expect(signedIn.json()).toMatchObject({accountID:first.accountID,credentialCount:2});
      const me=await app.inject({url:'/api/v1/wallet/me',headers:{authorization:`Bearer ${signedIn.json().token}`}});
      expect(me.json()).toMatchObject({credentialCount:2,recoveryReady:false,walletDeploymentEnabled:false});
      await Promise.all([next.token,otherSession.token,foreignSession.token,signedIn.json().token].map(t=>revokeSession(t)));
    } finally {await app.close();}
  });
  it('rejects unsupported enrollment algorithms, wrong origins and missing user verification without saving credentials',async()=>{
    const app=await buildApp({config:getConfig({WALLET_ORIGIN:'https://wallet.example'}),logger:false});
    const post=(path:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:`/api/v1/passkeys/registration/${path}`,headers:{origin:'https://wallet.example'},payload});
    try {
      for(const failure of ['algorithm','origin','verification']) {
        const key=testPasskey(failure==='algorithm'?'EdDSA':'ES256');
        const initial=(await post('options',{email:`${randomUUID()}@example.com`})).json();
        const response=key.registration(initial.options.challenge,failure==='origin'?'https://evil.example':'https://wallet.example',failure!=='verification');
        expect((await post('verify',{accountID:initial.accountID,requestID:initial.requestID,response})).statusCode).toBe(400);
        const result=await db.query('SELECT id FROM wallet_credentials WHERE account_id=$1',[initial.accountID]);
        expect(result.rows).toEqual([]);
        const sessions=await db.query('SELECT token_hash FROM wallet_sessions WHERE account_id=$1',[initial.accountID]);expect(sessions.rows).toEqual([]);
      }
    } finally {await app.close();}
  });
  it('scopes wallets to the authenticated owner',async () => {
    expect(await repository.wallet(wallet.id,account.id)).toMatchObject(wallet);
    await expect(repository.wallet(wallet.id,randomUUID())).rejects.toMatchObject({code:'WALLET_NOT_FOUND'});
    expect((await repository.walletsForOwner(account.id)).map(w=>w.id)).toContain(wallet.id);
    expect(await repository.walletsForOwner(randomUUID())).toEqual([]);
  });
  it('authenticates payment routes with persisted sessions and immediately observes revocation', async () => {
    const service = new PaymentService(repository, mockChain(), mockPolicy(), 1);
    // This test exercises HTTP + real persistence, without running the RPC monitor.
    service.tick = async () => {};
    const config = getConfig({ WALLET_ORIGIN: 'https://wallet.example' });
    const app = await buildApp({ config, payments: service, logger: false });
    const session = await createSession(account.id);
    const other = await createAccount(`${randomUUID()}@example.com`);
    const outsider = await createSession(other.id);
    const url = `/api/v1/wallets/${wallet.id}`;
    try {
      expect((await app.inject({ url })).statusCode).toBe(401);
      expect((await app.inject({ url, headers: { authorization: `Bearer ${outsider.token}` } })).statusCode).toBe(404);
      const response = await app.inject({ url, headers: { authorization: `Bearer ${session.token}` } });
      expect(response.statusCode).toBe(200);
      expect(response.json().address).toBe(wallet.address);
      const discovered=await app.inject({url:'/api/v1/wallets',headers:{authorization:`Bearer ${session.token}`}});
      expect(discovered.json().items).toEqual([{id:wallet.id,address:wallet.address,network:'TESTNET'}]);
      expect((await app.inject({url:'/api/v1/wallets',headers:{authorization:`Bearer ${outsider.token}`}})).json().items).toEqual([]);
      await revokeSession(session.token);
      expect((await app.inject({ url, headers: { authorization: `Bearer ${session.token}` } })).statusCode).toBe(401);
    } finally { await app.close(); await revokeSession(outsider.token); }
  });

  it('provisions reviewed accounts atomically and idempotently without silently replacing saved authority',async()=>{
    const owner=await createAccount(`${randomUUID()}@example.com`), fixture=manifestFixture();
    const approved={...fixture.accounts[0],owner:owner.id,walletId:randomUUID(),address:StrKey.encodeContract(Buffer.from(randomUUID().replaceAll('-','').repeat(2),'hex'))};
    const manifest={...fixture,accounts:[approved]};
    // Chain policy is injected; this test proves SQL boundaries, not live deployment.
    const policies={current:async()=>({fingerprint:'d'.repeat(64),recoveryReady:true})};
    const check=await provisionAccounts(manifest,false,{pool:db,policies});
    expect(check).toMatchObject({applied:false,wallets:[{action:'create'}]});
    expect(await repository.walletsForOwner(owner.id)).toEqual([]);
    const results=await Promise.all([provisionAccounts(manifest,true,{pool:db,policies}),provisionAccounts(manifest,true,{pool:db,policies})]);
    expect(results.flatMap(r=>r.wallets.map(w=>w.action)).sort()).toEqual(['create','unchanged']);
    expect(await repository.wallet(approved.walletId,owner.id)).toMatchObject({address:approved.address,policy:'d'.repeat(64),routes:['classic','contract']});
    await expect(provisionAccounts(manifest,true,{pool:db,policies:{current:async()=>({fingerprint:'e'.repeat(64),recoveryReady:true})}})).rejects.toThrow('EXISTING_WALLET_BINDING_CONFLICT');
    const outsider=await createAccount(`${randomUUID()}@example.com`);
    await expect(provisionAccounts({...manifest,accounts:[{...approved,owner:outsider.id}]},true,{pool:db,policies})).rejects.toThrow('EXISTING_WALLET_BINDING_CONFLICT');
    expect((await repository.wallet(approved.walletId,owner.id)).policy).toBe('d'.repeat(64));
  });
  it('rolls back every new wallet if a later provisioning entry fails chain verification',async()=>{
    const owner=await createAccount(`${randomUUID()}@example.com`), fixture=manifestFixture();
    const a={...fixture.accounts[0],owner:owner.id,walletId:randomUUID(),address:StrKey.encodeContract(Buffer.alloc(32,31))};
    const b={...a,walletId:randomUUID(),address:StrKey.encodeContract(Buffer.alloc(32,32))};
    const policies={current:async(address:string)=>{if(address===b.address)throw Error('RPC failure');return {fingerprint:'d'.repeat(64),recoveryReady:true};}};
    await expect(provisionAccounts({...fixture,accounts:[a,b]},true,{pool:db,policies})).rejects.toThrow('RPC failure');
    expect(await repository.walletsForOwner(owner.id)).toEqual([]);
  });
  it('serializes idempotent creates and fences one unresolved relayer payment',async () => {
    const intent:Intent={network:'TESTNET',destination:'G'+'A'.repeat(55),amountStroops:'10000000',maxFeeStroops:'1000'};
    const key='payment_'+randomUUID().replaceAll('-','');
    const [first,second]=await Promise.all([repository.create(wallet,intent,key),repository.create(wallet,intent,key)]);
    expect(first.id).toBe(second.id);
    expect(await repository.byKey(wallet.id,key)).toMatchObject({id:first.id});
    await expect(repository.create(wallet,{...intent,amountStroops:'20000000'},key)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    await expect(repository.create(wallet,intent,'second_'+key)).rejects.toMatchObject({code:'RELAYER_BUSY_RESOLVE_EXISTING_ATTEMPT'});
    const {attempt,token}=await repository.claim(first.id,['preparing']);
    await expect(repository.claim(first.id,['preparing'])).rejects.toMatchObject({code:'ATTEMPT_BUSY_OR_INVALID_STATE'});
    attempt.status='rejected';
    await repository.finish(attempt,token);
    await expect(repository.checkpoint(attempt,token)).rejects.toMatchObject({code:'LEASE_LOST'});
    const next=await repository.create(wallet,intent,'second_'+key);
    expect(next.id).not.toBe(first.id);
    const claim=await repository.claim(next.id,['preparing']);
    claim.attempt.status='rejected';
    await repository.finish(claim.attempt,claim.token);
  });
  it('rolls back event collisions and cursor changes atomically',async () => {
    const hash='a'.repeat(64);
    const event:TransferEvent={id:'TESTNET:'+hash+':0:0',transactionHash:hash,ledger:1234,operationIndex:0,eventIndex:0,from:wallet.address,to:'G'+'A'.repeat(55),amountStroops:'12345',closedAt:Date.now()};
    expect(await repository.cursor()).toBeUndefined();
    await repository.ingest([event],undefined,'ledger-1234');
    expect(await repository.cursor()).toBe('ledger-1234');
    await expect(repository.ingest([{...event,amountStroops:'55555'}],'ledger-1234','ledger-1235')).rejects.toMatchObject({code:'EVENT_ID_COLLISION'});
    expect(await repository.cursor()).toBe('ledger-1234');
    await expect(repository.ingest([event],'wrong-cursor','ledger-1235')).rejects.toMatchObject({code:'CURSOR_CHANGED'});
    await repository.ingest([event],'ledger-1234','ledger-1235');
    expect((await repository.history(wallet.address))[0].event).toMatchObject(event);
  });
  it('does not overwrite newer balances with stale ledger data',async () => {
    await repository.setBalance(wallet.address,'3000',300);
    await repository.setBalance(wallet.address,'9000',250);
    expect(await repository.balance(wallet.address)).toMatchObject({amountStroops:'3000',ledger:300});
  });

  it('persists signed attempt bytes across repository instances', async () => {
    const intent:Intent={network:'TESTNET',destination:'G'+'A'.repeat(55),amountStroops:'25000000',maxFeeStroops:'1000'};
    const key='persist_'+randomUUID().replaceAll('-','');
    const created=await repository.create(wallet,intent,key);
    const first=await repository.claim(created.id,['preparing']);
    first.attempt.prepared={transactionXdr:'preview',authXdr:'auth',feeStroops:'100',expiresAt:Date.now()+120000,expirationLedger:50000,ledger:49900};
    first.attempt.status='awaiting_approval';
    await repository.finish(first.attempt,first.token);
    const second=await repository.claim(created.id,['awaiting_approval']);
    second.attempt.status='authorizing';
    await repository.checkpoint(second.attempt,second.token);
    second.attempt.status='ready';
    second.attempt.signedXdr='test-signed-xdr';
    second.attempt.transactionHash='c'.repeat(64);
    await repository.finish(second.attempt,second.token);
    const reopened=new PostgresPaymentRepository(db);
    expect(await reopened.get(created.id)).toMatchObject({status:'ready',signedXdr:'test-signed-xdr',transactionHash:'c'.repeat(64)});
    expect(await reopened.byKey(wallet.id,key)).toMatchObject({id:created.id});
    const third=await reopened.claim(created.id,['ready']);
    await expect(repository.checkpoint({...third.attempt,status:'unknown'},second.token)).rejects.toMatchObject({code:'LEASE_LOST'});
    third.attempt.status='unknown';
    await reopened.checkpoint(third.attempt,third.token);
    expect((await reopened.get(created.id)).status).toBe('unknown');
    third.attempt.status='failed';
    await reopened.finish(third.attempt,third.token);
  });
  it('rolls back terminal status and relayer release on event identity collision',async () => {
    const intent:Intent={network:'TESTNET',destination:'G'+'A'.repeat(55),amountStroops:'4444',maxFeeStroops:'1000'};
    const attempt=await repository.create(wallet,intent,'collision_'+randomUUID().replaceAll('-',''));
    const lease=await repository.claim(attempt.id,['preparing']);
    const hash='a'.repeat(64);
    const changed:TransferEvent={id:'TESTNET:'+hash+':0:0',transactionHash:hash,ledger:1234,operationIndex:0,eventIndex:0,from:wallet.address,to:'G'+'A'.repeat(55),amountStroops:'99999',closedAt:Date.now()};
    lease.attempt.status='rejected';
    await expect(repository.finish(lease.attempt,lease.token,[changed])).rejects.toMatchObject({code:'EVENT_ID_COLLISION'});
    expect(await repository.get(attempt.id)).toMatchObject({status:'preparing',leaseToken:lease.token});
    const {rows}=await db.query('SELECT attempt_id FROM wallet_relayer_locks WHERE id=$1',['TESTNET:native_xlm_sac:relayer']);
    expect(rows[0].attempt_id).toBe(attempt.id);
    await repository.finish(lease.attempt,lease.token);
  });
  it('consumes transfer approvals once across workers and rejects other/revoked sessions',async()=>{
    const intent:Intent={network:'TESTNET',destination:'G'+'A'.repeat(55),amountStroops:'1',maxFeeStroops:'100'};
    const a=await repository.create(wallet,intent,'ticket_'+randomUUID());
    const session=await createSession(account.id);
    const tickets=new PostgresApprovalTickets(db), restarted=new PostgresApprovalTickets(db);
    const t={id:randomUUID(),owner:account.id,walletId:wallet.id,attemptId:a.id,sessionHash:hashToken(session.token),binding:{challenge:'a'.repeat(43),credentialIds:['credential'],policy:wallet.policy,authHash:'b'.repeat(64),requestDigest:a.requestDigest},expiresAt:Date.now()+60000};
    await tickets.put(t);
    await expect(tickets.take(t.id,account.id,wallet.id,a.id,'other')).rejects.toThrow();
    const results=await Promise.allSettled([tickets.take(t.id,account.id,wallet.id,a.id,t.sessionHash),restarted.take(t.id,account.id,wallet.id,a.id,t.sessionHash)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    await tickets.put({...t,id:randomUUID()});
    await revokeSession(session.token);
    const {rows}=await db.query('SELECT id FROM wallet_transfer_approvals WHERE session_hash=$1',[t.sessionHash]);expect(rows).toHaveLength(0);
    await expect(tickets.put({...t,id:randomUUID()})).rejects.toThrow('AUTHENTICATION_REQUIRED');
    const lease=await repository.claim(a.id,['preparing']);lease.attempt.status='rejected';await repository.finish(lease.attempt,lease.token);
  });
  it('verifies real P-256 transfer assertions, origin, challenge and counter under a database lock',async()=>{
    const owner=await createAccount(`${randomUUID()}@example.com`), credentialId=Buffer.from(randomUUID()).toString('base64url');
    const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const jwk=publicKey.export({format:'jwk'});
    const cose=new Map<number,number|Uint8Array>([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(jwk.x!,'base64url'))],[-3,new Uint8Array(Buffer.from(jwk.y!,'base64url'))]]);
    await withLockedAccount(owner.id,c=>addCredentialLocked(c,owner.id,{id:credentialId,publicKey:isoCBOR.encode(cose),counter:0,transports:['internal']}));
    const challenge=Buffer.alloc(32,7).toString('base64url');
    const assertion=(origin:string,challengeValue:string,counter:number)=>{
      const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:challengeValue,origin,crossOrigin:false}));
      const auth=Buffer.concat([createHash('sha256').update('wallet.example').digest(),Buffer.from([5]),Buffer.alloc(4)]);auth.writeUInt32BE(counter,33);
      const signature=sign('sha256',Buffer.concat([auth,createHash('sha256').update(client).digest()]),privateKey);
      return {id:credentialId,rawId:credentialId,type:'public-key' as const,response:{clientDataJSON:client.toString('base64url'),authenticatorData:auth.toString('base64url'),signature:signature.toString('base64url')},clientExtensionResults:{}};
    };
    const verify=postgresAssertionVerifier('wallet.example','https://wallet.example');
    await expect(verify(owner.id,assertion('https://evil.example',challenge,1),challenge,[credentialId])).rejects.toThrow();
    await expect(verify(owner.id,assertion('https://wallet.example','wrong-challenge',1),challenge,[credentialId])).rejects.toThrow();
    const valid=assertion('https://wallet.example',challenge,1);
    await verify(owner.id,valid,challenge,[credentialId]);
    await expect(verify(owner.id,valid,challenge,[credentialId])).rejects.toThrow();
    await expect(verify(owner.id,assertion('https://wallet.example',challenge,2),challenge,['not-authorized'])).rejects.toThrow('CREDENTIAL_NOT_AUTHORIZED');
  });

});


