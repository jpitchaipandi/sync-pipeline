import type { Job } from 'pg-boss';
import { z } from 'zod';
import { logger } from '../core/logger.js';
import { runSource, type RunSourceArgs } from '../core/sync-orchestrator.js';
import { getQueue } from './queue.js';

export const SYNC_QUEUE = 'sync.run';

const SourceIdSchema = z.enum(['hubspot', 'google-calendar', 'notion']);
const SyncModeSchema = z.enum(['incremental', 'full']);

export const SyncJobDataSchema = z.object({
  source: SourceIdSchema,
  mode: SyncModeSchema,
  triggeredBy: z.string().optional(),
});

export type SyncJobData = z.infer<typeof SyncJobDataSchema>;

/**
 * Enqueue a sync job. Uses pg-boss `singletonKey` so at most one job per
 * (source, mode) pair is active at a time — overlapping triggers (cron +
 * manual + webhook) collapse to a single run.
 *
 * Returns the job id, or null when pg-boss rejected the send because an
 * identical singleton job is already active.
 */
export async function enqueueSync(data: SyncJobData): Promise<string | null> {
  const boss = getQueue();
  const singletonKey = `${data.source}:${data.mode}`;
  const jobId = await boss.send(SYNC_QUEUE, data, {
    singletonKey,
    // singletonMinutes: 0 means "active singleton, no debounce window".
    retryLimit: 0,
  });
  if (jobId) {
    logger.info({ jobId, ...data }, 'sync_job_enqueued');
  } else {
    logger.info({ ...data, singletonKey }, 'sync_job_skipped_singleton_active');
  }
  return jobId;
}

/**
 * Register the worker that consumes sync.run jobs. Called once at startup
 * after pg-boss has started. Each job triggers a single orchestrator run.
 */
export async function registerSyncWorker(): Promise<void> {
  const boss = getQueue();

  await boss.createQueue(SYNC_QUEUE);

  await boss.work<SyncJobData>(SYNC_QUEUE, async (jobs: Job<SyncJobData>[]) => {
    for (const job of jobs) {
      const parsed = SyncJobDataSchema.safeParse(job.data);
      if (!parsed.success) {
        logger.error({ jobId: job.id, issues: parsed.error.issues }, 'sync_job_invalid_payload');
        throw new Error('Invalid sync job payload');
      }
      const args: RunSourceArgs =
        parsed.data.triggeredBy !== undefined
          ? { source: parsed.data.source, mode: parsed.data.mode, triggeredBy: parsed.data.triggeredBy }
          : { source: parsed.data.source, mode: parsed.data.mode };
      await runSource(args);
    }
  });

  logger.info({ queue: SYNC_QUEUE }, 'sync_worker_registered');
}
