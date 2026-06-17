import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function ensureMigrationsTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedMigrations(pool: pg.Pool): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  return new Set(result.rows.map((r) => r.filename));
}

async function applyMigration(pool: pg.Pool, filename: string, sql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
    logger.info({ filename }, 'Migration applied');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function runMigrations(): Promise<void> {
  // Migrations require DDL — prefer direct (port 5432) connection if provided.
  const connectionString = env.DATABASE_URL_DIRECT ?? env.DATABASE_URL;
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await ensureMigrationsTable(pool);
    const applied = await getAppliedMigrations(pool);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      logger.warn('No migration files found');
      return;
    }

    let appliedCount = 0;
    for (const filename of files) {
      if (applied.has(filename)) {
        logger.debug({ filename }, 'Migration already applied, skipping');
        continue;
      }
      const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
      await applyMigration(pool, filename, sql);
      appliedCount++;
    }

    logger.info({ total: files.length, applied: appliedCount }, 'Migrations complete');
  } finally {
    await pool.end();
  }
}

// Run when invoked directly via `tsx src/db/migrate.ts`
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.fatal({ err }, 'Migration failed');
      process.exit(1);
    });
}
