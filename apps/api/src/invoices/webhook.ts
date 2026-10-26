import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { requireThat } from '../payments/model.js';
import { invoiceTransaction } from './service.js';

export type InvoiceWebhookConfig = { url:string; secret:string; walletIds:string[] };
export function invoiceWebhookConfig(env:NodeJS.ProcessEnv):InvoiceWebhookConfig|undefined {
  const {WALLET_INVOICE_WEBHOOK_URL:url,WALLET_INVOICE_WEBHOOK_SECRET:secret,WALLET_INVOICE_WEBHOOK_WALLET_IDS:ids}=env;
  if(!url&&!secret&&!ids)return;
  let target:URL;
  try { target=new URL(url!); } catch { throw Error('INVOICE_WEBHOOK_CONFIGURATION_INVALID'); }
  // Destination is operator configuration only; invoice/QR callers cannot select a URL.
  requireThat(target.protocol==='https:' && !target.username && !target.password && !target.search && !target.hash && !!secret && secret.length>=32 && !!ids,'INVOICE_WEBHOOK_CONFIGURATION_INVALID');
  const walletIds=ids.split(',');
  requireThat(walletIds.length<=100 && walletIds.every(id=>/^[A-Za-z0-9_-]{1,128}$/.test(id)),'INVOICE_WEBHOOK_CONFIGURATION_INVALID');
  return {url:target.href,secret,walletIds:[...new Set(walletIds)]};
}
export function webhookSignature(secret:string,timestamp:string,body:string) {
  return 'v1='+createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex');
}
export class InvoiceWebhookWorker {
  constructor(readonly pool:Pool,readonly config:InvoiceWebhookConfig,readonly transport:typeof fetch=fetch) {}
  async tick() {
    for(let i=0;i<10;i++) {
      const item=await invoiceTransaction(this.pool,async client=>{
        const {rows}=await client.query(`SELECT * FROM wallet_invoice_outbox WHERE delivered_at IS NULL AND wallet_id=ANY($1::text[])
          AND next_attempt_at<=$2 AND lease_until<=$2 ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,[this.config.walletIds,Date.now()]);
        if(!rows[0])return;
        const token=randomUUID();
        await client.query('UPDATE wallet_invoice_outbox SET lease_token=$2,lease_until=$3,attempts=attempts+1 WHERE id=$1',[rows[0].id,token,Date.now()+60000]);
        return {...rows[0],token};
      });
      if(!item)return;
      const timestamp=Math.floor(Date.now()/1000).toString(),body=JSON.stringify(item.payload);
      let delivered=false;
      try {
        const response=await this.transport(this.config.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{
          'Content-Type':'application/json','X-CherryPay-Event-Id':item.id,'X-CherryPay-Timestamp':timestamp,'X-CherryPay-Signature':webhookSignature(this.config.secret,timestamp,body)
        },body});
        delivered=response.ok;
        await response.body?.cancel();
      } catch { /* Persist retry without logging request bodies, signatures, URLs or secrets. */ }
      await this.pool.query(`UPDATE wallet_invoice_outbox SET delivered_at=$3,next_attempt_at=$4,lease_token=NULL,lease_until=0 WHERE id=$1 AND lease_token=$2`,
        [item.id,item.token,delivered?Date.now():null,Date.now()+Math.min(3600000,5000*2**Math.min(item.attempts,10))]);
    }
  }
}
