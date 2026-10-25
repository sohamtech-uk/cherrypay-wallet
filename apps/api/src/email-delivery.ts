import { getExchangeMailConfig, type ExchangeMailConfig } from './config.js';

/** Exchange Online app-only OAuth via Microsoft Graph. No SMTP passwords. */
export async function sendVerificationEmail(email: string, code: string, config: ExchangeMailConfig = getExchangeMailConfig()): Promise<void> {
  if (!/^[0-9]{8}$/.test(code)) throw Error('INVALID_VERIFICATION_CODE');
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const tokenResponse = await fetch('https://login.microsoftonline.com/' + encodeURIComponent(config.tenantId) + '/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!tokenResponse.ok) throw Error('AZURE_MAIL_TOKEN_FAILED');
  const tokenData: unknown = await tokenResponse.json();
  if (!tokenData || typeof tokenData !== 'object' || !('access_token' in tokenData) || typeof tokenData.access_token !== 'string') throw Error('AZURE_MAIL_TOKEN_INVALID');
  const response = await fetch(config.graphBaseUrl + '/users/' + encodeURIComponent(config.sender) + '/sendMail', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tokenData.access_token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: 'Verify your Cherry Wallet email',
        from: { emailAddress: { address: config.sender, name: config.senderName } },
        body: { contentType: 'Text', content: 'Your Cherry Wallet verification code is ' + code + '. It expires in 15 minutes. Never share this code.' },
        toRecipients: [{ emailAddress: { address: email } }],
      },
      saveToSentItems: config.saveToSentItems,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 202) throw Error('AZURE_MAIL_SEND_FAILED');
}
