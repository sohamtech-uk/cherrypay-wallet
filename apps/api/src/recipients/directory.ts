import type { Pool } from 'pg';
import { db, normalizeEmail } from '../store.js';
import { requireThat } from '../payments/model.js';

/** A directory match proves control of an email inbox plus a verified, registered Testnet C-wallet.
 * It does NOT prove the recipient's legal identity. Lookup is exact-match and opt-in only. */
export async function resolveRecipient(email: string, sender: string, pool: Pick<Pool, 'query'> = db) {
  let normalized: string;
  try { normalized = normalizeEmail(email); } catch { throw new Error('INVALID_RECIPIENT_EMAIL'); }
  requireThat(normalized !== sender, 'RECIPIENT_NOT_AVAILABLE', 404);
  const { rows } = await pool.query<{ email: string; address: string }>(
    `SELECT a.id AS email, w.address
     FROM wallet_accounts a
     JOIN wallet_onchain_accounts w ON w.owner=a.id AND w.network='TESTNET'
     JOIN wallet_deployment_jobs d ON d.account_id=a.id
          AND d.contract_address=w.address
          AND d.status IN ('CONFIRMED','ACTIVE') AND d.binding_verified_at IS NOT NULL
     WHERE a.id=$1 AND a.email_payments_enabled=TRUE
       AND a.email_verified_at IS NOT NULL
       AND w.address ~ '^C[A-Z2-7]{55}$'
     ORDER BY w.id LIMIT 2`,
    [normalized]
  );
  requireThat(rows.length === 1, 'RECIPIENT_NOT_AVAILABLE', 404);
  return { network: 'TESTNET' as const, email: rows[0].email, address: rows[0].address,
    mailboxVerified: true as const, walletBindingVerified: true as const,
    legalIdentityVerified: false as const };
}

export async function setDirectoryPreference(accountID: string, enabled: boolean, pool: Pick<Pool, 'query'> = db) {
  requireThat(typeof enabled === 'boolean', 'INVALID_DIRECTORY_PREFERENCE', 400);
  // An enabled listing MUST have a confirmed binding and verified inbox.
  const { rows } = await pool.query<{ email_payments_enabled: boolean; email_verified_at: Date | null }>(
    `UPDATE wallet_accounts a
        SET email_payments_enabled=$2
      WHERE id=$1 AND (
          $2=FALSE OR (
            a.email_verified_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM wallet_deployment_jobs d
              JOIN wallet_onchain_accounts w ON w.owner=a.id AND w.address=d.contract_address
              WHERE d.account_id=a.id AND d.status IN ('CONFIRMED','ACTIVE')
                AND d.binding_verified_at IS NOT NULL AND w.network='TESTNET'
                AND w.address ~ '^C[A-Z2-7]{55}$'
            )
          )
      )
      RETURNING email_payments_enabled,email_verified_at`,
    [accountID,enabled]
  );
  requireThat(rows.length === 1, 'VERIFIED_EMAIL_AND_WALLET_REQUIRED', 409);
  return { emailPaymentsEnabled: rows[0].email_payments_enabled, emailVerified: rows[0].email_verified_at !== null };
}
