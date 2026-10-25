/**
 * Operator CLI: register a deployed Testnet smart account for an existing Cherry Pay user.
 *
 *   npm run register-wallet -- --owner <account UUID> --address <C...>
 *
 * Uses SMART_ACCOUNT_TRANSFER_RULE_IDS / SMART_ACCOUNT_RECOVERY_RULE_ID and DB_* from the
 * environment. Reads the contract, verifies code, rules and that every on-chain passkey is
 * one of the owner's registered credentials, then stores the policy fingerprint.
 * An existing row is never overwritten; a changed policy is reported and must be reviewed.
 */
import { randomUUID } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { db } from '../src/store.js';
import { ContractRulePolicyReader, TestnetContractRuleReader } from '../src/smart-account/contract-rule-reader.js';
import { SMART_ACCOUNT_KIT } from '../src/smart-account/kit-manifest.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
const owner = arg('owner'), address = arg('address');
if (!/^[0-9a-f-]{36}$/i.test(owner)) throw new Error('--owner must be a wallet_accounts UUID');
if (!StrKey.isValidContract(address)) throw new Error('--address must be a C-address');
const transferRuleIds = (process.env.SMART_ACCOUNT_TRANSFER_RULE_IDS ?? '').split(',').filter(Boolean).map(Number);
const recovery = process.env.SMART_ACCOUNT_RECOVERY_RULE_ID;
try {
  const reader = new TestnetContractRuleReader({ transferRuleIds, recoveryRuleId: recovery ? Number(recovery) : undefined, verifier: SMART_ACCOUNT_KIT.webauthnVerifierAddress });
  const policy = await new ContractRulePolicyReader(reader, new Map([[address, owner]])).current(address);
  const existing = await db.query('SELECT id, owner, policy FROM wallet_onchain_accounts WHERE address=$1', [address]);
  if (existing.rows.length) {
    const row = existing.rows[0];
    console.log(JSON.stringify({ status: row.owner === owner && row.policy === policy.fingerprint ? 'already_registered' : 'existing_row_differs', walletId: row.id, recoveryReady: policy.recoveryReady }));
  } else {
    const walletId = randomUUID();
    await db.query("INSERT INTO wallet_onchain_accounts(id,owner,network,address,policy,routes,created_at) VALUES($1,$2,'TESTNET',$3,$4,'[\"classic\"]'::jsonb,$5)", [walletId, owner, address, policy.fingerprint, Date.now()]);
    console.log(JSON.stringify({ status: 'registered', walletId, address, fingerprint: policy.fingerprint, recoveryReady: policy.recoveryReady }));
  }
  if (!policy.recoveryReady) console.error('Warning: no independent recovery rule; payments will refuse this wallet.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.end();
}
