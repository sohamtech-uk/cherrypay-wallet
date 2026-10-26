import { Pool } from 'pg';
import { databaseConfig } from './database-config.js';
import { initializeDatabaseRole } from './database-bootstrap.js';
const url=process.env.DATABASE_ADMIN_URL, password=process.env.DATABASE_RUNTIME_PASSWORD;
if (!url || !password) { console.error('WALLET_DATABASE_BOOTSTRAP_CONFIG_REQUIRED'); process.exitCode=1; }
else {
  let pool: Pool | undefined;
  try {
    pool=new Pool(databaseConfig({NODE_ENV:'production',DATABASE_URL:url}));
    pool.on('error',()=>console.error('WALLET_DATABASE_CONNECTION_LOST'));
    await initializeDatabaseRole(pool,password);
    const runtime=new URL(url); runtime.username='wallet_runtime'; runtime.password=password;
    const check=new Pool(databaseConfig({NODE_ENV:'production',DATABASE_URL:runtime.toString()}));
    try { await check.query('SELECT 1'); } finally { await check.end(); }
    console.log('WALLET_DATABASE_BOOTSTRAP_COMPLETE');
  } catch { console.error('WALLET_DATABASE_BOOTSTRAP_FAILED'); process.exitCode=1; }
  finally { await pool?.end(); }
}
