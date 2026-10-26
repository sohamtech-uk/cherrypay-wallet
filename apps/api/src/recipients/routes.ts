import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PaymentError, requireThat } from '../payments/model.js';
import { createEmailVerification, emailForAccount, normalizeEmail, sessionAccount, verifyEmail } from '../store.js';
import { sendVerificationEmail } from '../email-delivery.js';
import { resolveRecipient, setDirectoryPreference } from './directory.js';

const emailSchema = { type: 'string', minLength: 3, maxLength: 254 };
const path = '/api/v1/wallet';
const response = (code: string, status: number) => new PaymentError(code, status);

/** Authenticated, opt-in recipient lookup; no open directory or source of spend authority. */
export async function registerRecipientDirectoryRoutes(app: FastifyInstance,
  sendEmail: typeof sendVerificationEmail = sendVerificationEmail) {
  const counters = new Map<string, { count: number; until: number }>();
  function rateLimit(req: FastifyRequest, owner: string, category: string, allowance: number) {
    const now = Date.now();
    const key = category + ':' + owner + ':' + req.ip;
    const old = counters.get(key);
    if (counters.size > 10000) counters.clear();
    const entry = !old || old.until <= now ? { count: 1, until: now + 60_000 } : { count: old.count + 1, until: old.until };
    counters.set(key,entry);
    requireThat(entry.count <= allowance, 'RATE_LIMITED', 429);
  }
  async function authenticated(req: FastifyRequest) {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const id = await sessionAccount(token);
    requireThat(id, 'AUTHENTICATION_REQUIRED', 401);
    return id;
  }
  const handle = async (req: FastifyRequest, reply: any, work: () => Promise<unknown>) => {
    reply.header('Cache-Control','no-store');
    try { return await work(); }
    catch (e) {
      if (e instanceof PaymentError) return reply.code(e.status).send({ error: e.code });
      // Never return DB details, upstream mail errors or whether a mailbox is registered.
      if (e instanceof Error && e.message === 'INVALID_RECIPIENT_EMAIL') return reply.code(400).send({ error: 'INVALID_RECIPIENT_EMAIL' });
      req.log.warn({ code: 'RECIPIENT_DIRECTORY_UNAVAILABLE' }, 'Email directory operation unavailable');
      return reply.code(503).send({ error: 'RECIPIENT_DIRECTORY_UNAVAILABLE' });
    }
  };
  app.post(path + '/email-verification/request', { schema: { body: { type: 'object', additionalProperties: false } } }, (req,reply) =>
    handle(req,reply,async () => {
      const owner = await authenticated(req);
      rateLimit(req,owner,'email-verification',3);
      let email: string;
      try { email = normalizeEmail(owner); } catch { throw response('EMAIL_ACCOUNT_REQUIRED',409); }
      const identity = await emailForAccount(owner);
      requireThat(identity && identity.email === email, 'EMAIL_ACCOUNT_REQUIRED', 409);
      if (identity.email_verified_at) return { status:'already_verified' };
      const code = await createEmailVerification(owner);
      await sendEmail(email,code);
      return { status: 'sent', expiresInSeconds: 900 };
    }));
  app.post(path + '/email-verification/confirm', {
      schema: { body: { type:'object',required:['code'],additionalProperties:false,properties:{code:{type:'string',pattern:'^[0-9]{8}$'}} } }
    }, (req,reply) => handle(req,reply,async () => {
      const owner = await authenticated(req);
      rateLimit(req,owner,'email-verification-confirm',10);
      requireThat(await verifyEmail(owner,(req.body as {code:string}).code),'INVALID_OR_EXPIRED_CODE',400);
      return { emailVerified:true };
    }));
  app.post(path + '/email-directory', {
      schema: { body: { type:'object',required:['enabled'],additionalProperties:false,properties:{enabled:{type:'boolean'}} } }
    }, (req,reply) => handle(req,reply,async () => {
      const owner = await authenticated(req);
      rateLimit(req,owner,'email-directory-setting',10);
      return setDirectoryPreference(owner,(req.body as {enabled:boolean}).enabled);
    }));
  app.get('/api/v1/recipients/resolve', {
      schema: { querystring: { type:'object',required:['email'],additionalProperties:false,properties:{email:emailSchema} } }
    }, (req,reply) => handle(req,reply,async () => {
      const owner = await authenticated(req);
      rateLimit(req,owner,'email-lookup',10);
      return resolveRecipient((req.query as {email:string}).email, owner);
    }));
}
