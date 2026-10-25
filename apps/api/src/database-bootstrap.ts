import type { Pool } from 'pg';
const role = 'wallet_runtime';
/** Operator-only initialization for a dedicated wallet database, never an HTTP route. */
export async function initializeDatabaseRole(admin: Pool, password: string) {
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(password)) throw new Error('Invalid runtime password format');
  const client=await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('cherrypay_database_bootstrap'))");
    const database=(await client.query<{name:string}>('SELECT current_database() AS name')).rows[0].name;
    if (['postgres','template0','template1'].includes(database)) throw new Error('A dedicated wallet database is required');
    const existing=await client.query('SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[role]);
    if (!existing.rows.length) {
      // Password alphabet is explicitly bounded above; PostgreSQL DDL cannot bind PASSWORD as a parameter.
      await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 20 PASSWORD '${password}'`);
    } else {
      const r=existing.rows[0];
      const memberships=await client.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1',[role]);
      if (!r.rolcanlogin || r.rolsuper || r.rolcreatedb || r.rolcreaterole || r.rolreplication || r.rolbypassrls || memberships.rows.length) throw new Error('Existing wallet role has unexpected privileges');
      // Never rotate an existing password implicitly on a retry.
    }
    const quoted='"'+database.replaceAll('"','""')+'"';
    await client.query(`REVOKE ALL ON DATABASE ${quoted} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${quoted} TO ${role}`);
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await client.query(`GRANT USAGE,CREATE ON SCHEMA public TO ${role}`);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
