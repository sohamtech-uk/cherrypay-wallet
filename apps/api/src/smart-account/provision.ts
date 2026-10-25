import { rpc } from '@stellar/stellar-sdk';
import type { Pool } from 'pg';
import { db } from '../store.js';
import { TESTNET_RPC_URL } from '../config.js';
import { requireThat, type PolicyReader } from '../payments/model.js';
import { PinnedAccountAdapter } from './pinned-adapter.js';
import { parsePaymentManifest, type PaymentManifest } from './manifest.js';

/** Operator-only registration of ALREADY deployed and independently recovered
 * accounts. No chain submission, signer enrollment, policy update or owner change.
 * --check rolls back; --apply commits the complete batch or nothing.
 */
export async function provisionAccounts(input: PaymentManifest, apply = false, options: { pool?: Pool; policies?: PolicyReader } = {}) {
  const manifest = parsePaymentManifest(input);
  const client = await (options.pool ?? db).connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cherrypay_wallet_provision_v1'))");
    const owners = [...new Set(manifest.accounts.map(a => a.owner))].sort();
    const owned = await client.query('SELECT id FROM wallet_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [owners]);
    requireThat(owned.rows.length === owners.length, 'MANIFEST_OWNER_NOT_ENROLLED');
    const policies = options.policies ?? new PinnedAccountAdapter(new rpc.Server(TESTNET_RPC_URL, { timeout: 20 }), manifest.accounts, async owner => {
      const { rows } = await client.query<{id:string;public_key:string}>('SELECT id,public_key FROM wallet_credentials WHERE account_id=$1', [owner]);
      return rows;
    });
    const plan: { walletId: string; address: string; policy: string; action: 'create' | 'unchanged' }[] = [];
    for (const account of manifest.accounts) {
      const policy = await policies.current(account.address);
      requireThat(policy.recoveryReady && /^[a-f0-9]{64}$/.test(policy.fingerprint), 'RECOVERY_POLICY_NOT_READY');
      const { rows } = await client.query('SELECT * FROM wallet_onchain_accounts WHERE id=$1 OR address=$2 FOR UPDATE', [account.walletId, account.address]);
      const current = rows[0];
      if (current) {
        requireThat(rows.length === 1 && current.id === account.walletId && current.owner === account.owner && current.address === account.address && current.network === 'TESTNET' && current.policy === policy.fingerprint && JSON.stringify(current.routes) === '["classic","contract"]', 'EXISTING_WALLET_BINDING_CONFLICT');
      } else if (apply) {
        await client.query("INSERT INTO wallet_onchain_accounts(id,owner,network,address,policy,routes,created_at) VALUES($1,$2,'TESTNET',$3,$4,'[\"classic\",\"contract\"]'::jsonb,$5)", [account.walletId, account.owner, account.address, policy.fingerprint, Date.now()]);
      }
      plan.push({walletId:account.walletId,address:account.address,policy:policy.fingerprint,action:current?'unchanged':'create'});
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { applied: apply, wallets: plan };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
