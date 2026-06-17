import { PgBoss } from 'pg-boss';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';

let boss: PgBoss | null = null;

export async function startQueue(): Promise<PgBoss> {
  if (boss) return boss;

  boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    // pg-boss creates its own schema (pgboss.*) on first start.
    application_name: 'sync-pipeline',
  });

  boss.on('error', (err: Error) => {
    logger.error({ err }, 'pg-boss error');
  });

  await boss.start();
  logger.info('pg-boss started');
  return boss;
}

export async function stopQueue(): Promise<void> {
  if (!boss) return;
  await boss.stop({ graceful: true });
  logger.info('pg-boss stopped');
  boss = null;
}

export function getQueue(): PgBoss {
  if (!boss) {
    throw new Error('pg-boss not started — call startQueue() first');
  }
  return boss;
}
