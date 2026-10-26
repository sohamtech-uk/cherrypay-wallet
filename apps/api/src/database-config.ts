import type { PoolConfig } from 'pg';

/** Production connections verify both the PostgreSQL certificate and hostname. */
export function databaseConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const tls = env.DB_SSL ?? (env.NODE_ENV === 'production' ? 'true' : 'false');
  if (!['true', 'false'].includes(tls) || (env.NODE_ENV === 'production' && tls !== 'true')) {
    throw new Error('Verified database TLS is required in production');
  }
  if (env.DATABASE_URL && tls === 'true') {
    let url: URL;
    try { url = new URL(env.DATABASE_URL); } catch { throw new Error('Invalid database configuration'); }
    // pg connection-string SSL options overwrite the explicit ssl object.
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || [...url.searchParams.keys()].some(key => /^(ssl|uselibpqcompat)/i.test(key))) {
      throw new Error('Remove connection-string SSL options; DB_SSL controls verified TLS');
    }
  }
  return {
    ...(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {
      host: env.DB_HOST ?? '127.0.0.1', port: Number(env.DB_PORT ?? 5432),
      user: env.DB_USER ?? 'wallet', password: env.DB_PASSWORD,
      database: env.DB_NAME ?? 'cherrypay_wallet',
    }),
    ssl: tls === 'true' ? { rejectUnauthorized: true } : false,
    max: 10, connectionTimeoutMillis: 10_000,
  };
}
