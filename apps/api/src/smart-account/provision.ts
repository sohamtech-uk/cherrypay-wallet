import { rpc } from '@stellar/stellar-sdk';
import type { Pool } from 'pg';
import { db } from '../store.js';
import { TESTNET_RPC_URL } from '../config.js';
import { requireThat, type PolicyReader } from '../payments/model.js';
import { PinnedAccountAdapter } from './pinned-adapter.js';
import { parsePaymentManifest, type PaymentManifest } from './manifest.js';

export function parseProvisionArguments(args: readonly string[]) {
  const allowed = ['--check', '--apply', '--enable-contract-routes'];
  requireThat(args.length <= 2 && new Set(args).size === args.length && args.every(a => allowed.includes(a)) && !(args.includes('--check') && args.includes('--apply')), 'INVALID_PROVISION_ARGUMENTS');
  return { apply: args.includes('--apply'), enableContractRoutes: args.includes('--enable-contract-routes') };
}

/** Operator-only binding of already reviewed, deployed and recovered wallets.
 * No signer enrollment, chain submission, ownership or signer-policy replacement.
 * Existing classic-only rows require an explicit route-upgrade flag and no
 * unresolved attempt. All chain reads complete before acquiring SQL row locks.
 */
export async function provisionAccounts(input: PaymentManifest, apply = false, options: { pool?: Pool; policies?: PolicyReader; enableContractRoutes?: boolean } = {}) {
  const manifest = parsePaymentManifest(input);
  const pool = options.pool ?? db;
  const owners = [...new Set(manifest.accounts.map(a => a.owner))].sort();
  const knownOwners = await pool.query('SELECT id FROM wallet_accounts WHERE id = ANY($1::text[])', [owners]);
  requireThat(knownOwners.rows.length === owners.length, 'MANIFEST_OWNER_NOT_ENROLLED');
  const policies = options.policies ?? new PinnedAccountAdapter(new rpc.Server(TESTNET_RPC_URL, { timeout: 20 }), manifest.accounts, async owner => {
    const { rows } = await pool.query<{ id: string; public_key: string }>('SELECT id,public_key FROM wallet_credentials WHERE account_id=$1', [owner]);
    return rows;
  });
  const verified = new Map<string, { fingerprint: string; recoveryReady: boolean }>();
  for (const account of manifest.accounts) {
    const policy = await policies.current(account.address);
    requireThat(policy.recoveryReady && /^[a-f0-9]{64}$/.test(policy.fingerprint), 'RECOVERY_POLICY_NOT_READY');
    verified.set(account.address, policy);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cherrypay_wallet_provision_v1'))");
    const owners = [...new Set(manifest.accounts.map(a => a.owner))].sort();
    const owned = await client.query('SELECT id FROM wallet_accounts WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [owners]);
    requireThat(owned.rows.length === owners.length, 'MANIFEST_OWNER_NOT_ENROLLED');
    const plan: { walletId: string; address: string; policy: string; action: 'create' | 'unchanged' | 'enable-contract-routes' }[] = [];
    for (const account of manifest.accounts) {
      const policy = verified.get(account.address)!;
      const { rows } = await client.query('SELECT * FROM wallet_onchain_accounts WHERE id=$1 OR address=$2 FOR UPDATE', [account.walletId, account.address]);
      const current = rows[0];
      let action: 'create' | 'unchanged' | 'enable-contract-routes' = current ? 'unchanged' : 'create';
      if (current) {
        requireThat(rows.length === 1 && current.id === account.walletId && current.owner === account.owner && current.address === account.address && current.network === 'TESTNET' && current.policy === policy.fingerprint, 'EXISTING_WALLET_BINDING_CONFLICT');
        const routes = JSON.stringify(current.routes);
        if (routes === '["classic"]' && options.enableContractRoutes === true) {
          const active = await client.query("SELECT id FROM wallet_payment_attempts WHERE wallet_id=$1 AND status NOT IN ('confirmed','failed','rejected') LIMIT 1", [account.walletId]);
          requireThat(active.rowCount === 0, 'ROUTE_UPGRADE_REQUIRES_RESOLVED_ATTEMPTS');
          action = 'enable-contract-routes';
          if (apply) await client.query("UPDATE wallet_onchain_accounts SET routes='[\"classic\",\"contract\"]'::jsonb WHERE id=$1", [account.walletId]);
        } else {
          requireThat(routes === '["classic","contract"]', 'EXISTING_WALLET_BINDING_CONFLICT');
        }
      } else if (apply) {
        await client.query("INSERT INTO wallet_onchain_accounts(id,owner,network,address,policy,routes,created_at) VALUES($1,$2,'TESTNET',$3,$4,'[\"classic\",\"contract\"]'::jsonb,$5)", [account.walletId, account.owner, account.address, policy.fingerprint, Date.now()]);
      }
      plan.push({ walletId: account.walletId, address: account.address, policy: policy.fingerprint, action });
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { applied: apply, wallets: plan };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
