import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendVerificationEmail } from './email-delivery.js';
import { getExchangeMailConfig } from './config.js';

const config = {tenantId:'11111111-1111-4111-8111-111111111111',clientId:'22222222-2222-4222-8222-222222222222',clientSecret:'test-secret',sender:'wallet@example.com',senderName:'Cherry Wallet',invoiceFromEmail:'wallet@example.com',invoiceFromName:'Cherry Wallet',graphBaseUrl:'https://graph.microsoft.com/v1.0',timeoutMs:10000,connectTimeoutMs:5000,saveToSentItems:true,fallbackToMail:false};
afterEach(() => vi.unstubAllGlobals());

describe('Exchange Online verification mail', () => {
 it('requires complete Azure configuration', () => {
  expect(() => getExchangeMailConfig({})).toThrow('AZURE_MAIL_CONFIGURATION_INVALID');
 });
 it('obtains an app token and sends a text-only verification message', async () => {
  const mock = vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({access_token:'test-token'})})
    .mockResolvedValueOnce({status:202});
  vi.stubGlobal('fetch',mock);
  await sendVerificationEmail('alice@example.com','12345678',config);
  expect(mock).toHaveBeenCalledTimes(2);
  expect(String(mock.mock.calls[0][0])).toContain('/oauth2/v2.0/token');
  expect(String(mock.mock.calls[1][0])).toContain('/users/wallet%40example.com/sendMail');
  const request = mock.mock.calls[1][1] as {body:string};
  expect(JSON.parse(request.body).message.toRecipients[0].emailAddress.address).toBe('alice@example.com');
 });
 it('fails closed when Graph does not accept the email', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({access_token:'test-token'})}).mockResolvedValueOnce({status:403}));
  await expect(sendVerificationEmail('alice@example.com','12345678',config)).rejects.toThrow('AZURE_MAIL_SEND_FAILED');
 });
});
