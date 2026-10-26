import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  sessionAccount:vi.fn(), emailForAccount:vi.fn(), createEmailVerification:vi.fn(),
  verifyEmail:vi.fn(), query:vi.fn()
}));
vi.mock('../store.js',()=>({
  sessionAccount:mock.sessionAccount,
  emailForAccount:mock.emailForAccount,
  createEmailVerification:mock.createEmailVerification,
  verifyEmail:mock.verifyEmail,
  db:{query:mock.query},
  normalizeEmail:(email:string)=>{
    const normalized=email.trim().toLowerCase();
    if(!normalized.includes('@')||!normalized.includes('.')||normalized.includes(' '))throw Error('INVALID_EMAIL');
    return normalized;
  },
}));
import { registerRecipientDirectoryRoutes } from './routes.js';

const sender='sender@example.com';
const headers={authorization:'Bearer valid-session',origin:'https://wallet.example'};
let app:ReturnType<typeof Fastify>;
const sendEmail=vi.fn();
beforeEach(async()=>{
  vi.resetAllMocks();
  mock.sessionAccount.mockResolvedValue(sender);
  mock.emailForAccount.mockResolvedValue({email:sender,email_verified_at:null});
  mock.createEmailVerification.mockResolvedValue('12345678');
  mock.verifyEmail.mockResolvedValue(true);
  mock.query.mockResolvedValue({rows:[]});
  sendEmail.mockResolvedValue(undefined);
  app=Fastify({logger:false,ajv:{customOptions:{coerceTypes:false,removeAdditional:false}}});
  await registerRecipientDirectoryRoutes(app,sendEmail);
});
afterEach(async()=>{await app.close();});

describe('recipient directory authentication and privacy',()=>{
  it('requires a bearer session and never exposes unknown or private accounts',async()=>{
    mock.sessionAccount.mockResolvedValueOnce(null);
    expect((await app.inject({url:'/api/v1/recipients/resolve?email=unknown%40example.com'})).statusCode).toBe(401);
    const unknown=await app.inject({url:'/api/v1/recipients/resolve?email=unknown%40example.com',headers});
    expect(unknown.statusCode).toBe(404);expect(unknown.json()).toEqual({error:'RECIPIENT_NOT_AVAILABLE'});
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining('email_verified_at IS NOT NULL'),['unknown@example.com']);
    const bad=await app.inject({url:'/api/v1/recipients/resolve?email=not-an-email',headers});
    expect(bad.statusCode).toBe(400);
  });
  it('returns a single opt-in wallet mapping, without suggesting identity or KYC verification',async()=>{
    const addr='C'+'A'.repeat(55);
    mock.query.mockResolvedValueOnce({rows:[{email:'receiver@example.com',address:addr}]});
    const res=await app.inject({url:'/api/v1/recipients/resolve?email=RECEIVER%40EXAMPLE.COM',headers});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({network:'TESTNET',email:'receiver@example.com',address:addr,
      mailboxVerified:true,walletBindingVerified:true,legalIdentityVerified:false});
    mock.query.mockResolvedValueOnce({rows:[{email:'receiver@example.com',address:addr},{email:'receiver@example.com',address:addr}]});
    expect((await app.inject({url:'/api/v1/recipients/resolve?email=receiver%40example.com',headers})).statusCode).toBe(404);
  });
  it('requires verified mailbox and deployed wallet before opting in',async()=>{
    const result=await app.inject({method:'POST',url:'/api/v1/wallet/email-directory',headers,payload:{enabled:true}});
    expect(result.statusCode).toBe(409);
    expect(mock.query).toHaveBeenCalledWith(expect.stringContaining('binding_verified_at IS NOT NULL'),[sender,true]);
    mock.query.mockResolvedValueOnce({rows:[{email_payments_enabled:true,email_verified_at:new Date()}]});
    const permitted=await app.inject({method:'POST',url:'/api/v1/wallet/email-directory',headers,payload:{enabled:true}});
    expect(permitted.json()).toEqual({emailPaymentsEnabled:true,emailVerified:true});
    expect((await app.inject({method:'POST',url:'/api/v1/wallet/email-directory',headers,payload:{enabled:'true'}})).statusCode).toBe(400);
  });
  it('sends verification only to the authenticated account and uses a bounded code',async()=>{
    const start=await app.inject({method:'POST',url:'/api/v1/wallet/email-verification/request',headers,payload:{}});
    expect(start.statusCode).toBe(200);expect(start.json()).toEqual({status:'sent',expiresInSeconds:900});
    expect(sendEmail).toHaveBeenCalledWith(sender,'12345678');
    expect((await app.inject({method:'POST',url:'/api/v1/wallet/email-verification/request',headers,payload:{email:'other@example.com'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/api/v1/wallet/email-verification/confirm',headers,payload:{code:'12345678'}})).json()).toEqual({emailVerified:true});
    expect((await app.inject({method:'POST',url:'/api/v1/wallet/email-verification/confirm',headers,payload:{code:'123'}})).statusCode).toBe(400);
  });
  it('limits lookups per identity and IP instead of leaking a searchable wallet index',async()=>{
    for(let i=0;i<10;i++) {
      expect((await app.inject({url:'/api/v1/recipients/resolve?email=private%40example.com',headers})).statusCode).toBe(404);
    }
    expect((await app.inject({url:'/api/v1/recipients/resolve?email=another%40example.com',headers})).statusCode).toBe(429);
  });
});


it.each(['AZURE_MAIL_CONFIGURATION_INVALID','AZURE_MAIL_TOKEN_FAILED','AZURE_MAIL_SEND_FAILED','private provider error: recipient secret 12345678'])(
  'reports email delivery failure safely instead of claiming the message was sent: %s', async (reason) => {
    sendEmail.mockRejectedValueOnce(new Error(reason));
    const result = await app.inject({method:'POST',url:'/api/v1/wallet/email-verification/request',headers,payload:{}});
    expect(result.statusCode).toBe(503);
    expect(result.json()).toEqual({error:'EMAIL_DELIVERY_UNAVAILABLE'});
    expect(result.body).not.toContain(sender);
    expect(result.body).not.toContain('12345678');
    expect(mock.verifyEmail).not.toHaveBeenCalled();
  }
);
