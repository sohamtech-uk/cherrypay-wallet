import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { databaseConfig } from './database-config.js';
import { initializeDatabaseRole } from './database-bootstrap.js';

describe.skipIf(process.env.RUN_DB_INTEGRATION!=='1')('dedicated database bootstrap',()=>{
  it('grants schema access without server administration, and retries do not rotate credentials',async()=>{
    const name='wallet_bootstrap_'+randomBytes(6).toString('hex');
    const password=randomBytes(32).toString('hex');
    const base=databaseConfig();
    const control=new Pool(base);
    const admin=new Pool({...base,connectionString:undefined,database:name});
    let runtime:Pool|undefined;
    try {
      await control.query(`CREATE DATABASE ${name}`);
      await initializeDatabaseRole(admin,password);
      runtime=new Pool({...base,connectionString:undefined,database:name,user:'wallet_runtime',password});
      await runtime.query('CREATE TABLE public.bootstrap_probe(id INTEGER PRIMARY KEY)');
      await runtime.query('INSERT INTO public.bootstrap_probe VALUES(1)');
      await expect(runtime.query('CREATE DATABASE unauthorized_database')).rejects.toMatchObject({code:'42501'});
      await expect(runtime.query('CREATE ROLE unauthorized_role')).rejects.toMatchObject({code:'42501'});
      await expect(initializeDatabaseRole(admin,"unsafe'password")).rejects.toThrow('Invalid runtime password format');
      await initializeDatabaseRole(admin,randomBytes(32).toString('hex'));
      // A new connection proves the persisted password was not silently changed.
      const check=new Pool({...base,connectionString:undefined,database:name,user:'wallet_runtime',password});
      try { expect((await check.query('SELECT count(*) FROM bootstrap_probe')).rows[0].count).toBe('1'); } finally { await check.end(); }
      await admin.query('ALTER ROLE wallet_runtime CREATEDB');
      await expect(initializeDatabaseRole(admin,password)).rejects.toThrow('unexpected privileges');
    } finally {
      await runtime?.end(); await admin.end();
      await control.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await control.query('DROP ROLE IF EXISTS wallet_runtime');
      await control.end();
    }
  });
});
