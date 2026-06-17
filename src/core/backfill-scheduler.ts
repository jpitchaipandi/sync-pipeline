import { pool } from '../db/client.js';
import { logger } from './logger.js';
import * as cursorStore from './cursor-store.js';
import { enqueueSync } from '../jobs/sync-job.js';

/**
 * Find sources flagged for full backfill (set by orchestrator when a source's
 * cursor expired) and enqueue full-mode sync jobs for each.
 *
 * Idempotent: if a job for the same singletonKey is already in-flight,
 * pg-boss will reject the enqueue and we log + skip.
 */
export async function scheduleBackfills(): Promise<{ scheduled: number }> {
  const sources = await cursorStore.getSourcesNeedingBackfill(pool);
  if (sources.length === 0) {
    return { scheduled: 0 };
  }

  let scheduled = 0;
  for (const source of sources) {
    const jobId = await enqueueSync({
      source,
      mode: 'full',
      triggeredBy: 'backfill-scheduler',
    });
    if (jobId) {
      scheduled++;
      logger.info({ source, jobId }, 'backfill_scheduled');
    } else {
      logger.debug({ source }, 'backfill_skipped_already_in_flight');
    }
  }
  return { scheduled };
}
