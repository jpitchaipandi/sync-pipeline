import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Postgres pool error');
});

export const db = drizzle(pool);

export async function ping(): Promise<boolean> {
  try {
    const result = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    return result.rows[0]?.ok === 1;
  } catch (err) {
    logger.error({ err }, 'DB ping failed');
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
