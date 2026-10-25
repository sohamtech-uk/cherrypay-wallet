import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/** Exactly-once, checksum-pinned SQL migrations under a cross-process PG advisory lock. */
export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cherrypay_wallet_schema_v1'))");
    await client.query('CREATE TABLE IF NOT EXISTS wallet_schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    const names = (await readdir(dir)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    if (!names.length) throw new Error('No PostgreSQL wallet migrations found');
    const { rows } = await client.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM wallet_schema_migrations ORDER BY name');
    const existing = new Map(rows.map(r => [r.name, r.sha256]));
    if (rows.some(r => !names.includes(r.name))) throw new Error('An applied PostgreSQL migration is missing from source');
    for (const name of names) {
      const sql = await readFile(join(dir, name), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      if (existing.has(name)) {
        if (existing.get(name) !== sha256) throw new Error('Applied migration checksum mismatch: ' + name);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO wallet_schema_migrations(name,sha256) VALUES($1,$2)', [name,sha256]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
