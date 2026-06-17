import { timingSafeEqual } from 'node:crypto';
import { pool } from '../../db/client.js';
import { logger } from '../../core/logger.js';
import { enqueueSync } from '../../jobs/sync-job.js';

export interface VerifyChannelTokenArgs {
  provided: string | undefined;
  expected: string | undefined;
}

/**
 * Google Calendar push channels do not sign payloads. Authentication is
 * instead a static `token` field we set when creating the channel; Google
 * echoes it back as `X-Goog-Channel-Token` on every notification.
 */
export function verifyChannelToken(args: VerifyChannelTokenArgs): boolean {
  if (!args.expected || !args.provided) return false;
  if (args.provided.length !== args.expected.length) return false;
  return timingSafeEqual(
    Buffer.from(args.provided, 'utf8'),
    Buffer.from(args.expected, 'utf8'),
  );
}

export type GoogleResourceState = 'sync' | 'exists' | 'not_exists';

export interface HandleNotificationArgs {
  resourceState: GoogleResourceState;
  resourceId: string;
  messageNumber: string;
}

export interface HandleNotificationOutcome {
  action: 'ignored_sync_confirmation' | 'duplicate' | 'enqueued';
  jobId?: string;
}

/**
 * Process a Google push notification. The notification body is empty —
 * we infer everything from headers. On a change event we dedup by
 * (resourceId, messageNumber) and enqueue an incremental sync. The next
 * sync run picks up the actual delta via the stored syncToken.
 */
export async function handleNotification(
  args: HandleNotificationArgs,
): Promise<HandleNotificationOutcome> {
  if (args.resourceState === 'sync') {
    // Initial channel-creation confirmation; no action required.
    return { action: 'ignored_sync_confirmation' };
  }

  const eventId = `google-calendar:${args.resourceId}:${args.messageNumber}`;
  const insertResult = await pool.query(
    `INSERT INTO webhook_events (event_id, source, payload, status)
     VALUES ($1, 'google-calendar', $2::jsonb, 'received')
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [
      eventId,
      JSON.stringify({
        resourceState: args.resourceState,
        resourceId: args.resourceId,
        messageNumber: args.messageNumber,
      }),
    ],
  );

  if (insertResult.rowCount === 0) {
    return { action: 'duplicate' };
  }

  const jobId = await enqueueSync({
    source: 'google-calendar',
    mode: 'incremental',
    triggeredBy: 'webhook',
  });

  await pool.query(
    `UPDATE webhook_events SET status='processed', processed_at=NOW() WHERE event_id=$1`,
    [eventId],
  );

  logger.info({ resourceState: args.resourceState, jobId }, 'gcal_notification_enqueued');
  if (jobId) {
    return { action: 'enqueued', jobId };
  }
  return { action: 'enqueued' };
}
