import { describe, expect, it } from 'vitest';
import { databaseConfig } from './database-config.js';

describe('database TLS boundary', () => {
  it('keeps local PostgreSQL usable and verifies production certificates', () => {
    expect(databaseConfig({}).ssl).toBe(false);
    expect(databaseConfig({ NODE_ENV: 'production' }).ssl).toEqual({ rejectUnauthorized: true });
    expect(databaseConfig({ DB_SSL: 'true', DATABASE_URL: 'postgres://wallet:secret@db/wallet' }).ssl).toEqual({ rejectUnauthorized: true });
  });
  it.each(['false', '0', 'require', ''])('rejects a production TLS downgrade: %s', DB_SSL => {
    expect(() => databaseConfig({ NODE_ENV: 'production', DB_SSL })).toThrow();
  });
  it.each(['sslmode=disable', 'sslmode=require', 'ssl=false', 'sslrootcert=untrusted', 'uselibpqcompat=true'])('rejects URL overrides: %s', query => {
    expect(() => databaseConfig({ DB_SSL: 'true', DATABASE_URL: `postgres://wallet:secret@db/wallet?${query}` })).toThrow();
  });
  it('never includes connection credentials in configuration errors', () => {
    expect(() => databaseConfig({ DB_SSL: 'true', DATABASE_URL: 'secret broken URL' })).toThrow('Invalid database configuration');
  });
});
