import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../../db/client.js';
import { logger } from '../../core/logger.js';

/**
 * HubSpot Webhook v3 signature: HMAC-SHA256 over
 * `{HTTP_METHOD}{REQUEST_URI}{REQUEST_BODY}{TIMESTAMP}`
 * keyed with the app's client secret, base64-encoded.
 *
 * Reject if timestamp drift > 5 minutes (replay protection).
 */
const MAX_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

export interface VerifyArgs {
  method: string;
  uri: string;
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  clientSecret: string;
  now?: number;
}

export type VerifyOutcome =
  | { ok: true }
  | { ok: false; reason: 'missing_signature' | 'missing_timestamp' | 'stale_timestamp' | 'signature_mismatch' };

export function verifyHubspotSignature(args: VerifyArgs): VerifyOutcome {
  if (!args.signatureHeader) return { ok: false, reason: 'missing_signature' };
  if (!args.timestampHeader) return { ok: false, reason: 'missing_timestamp' };

  const timestamp = Number(args.timestampHeader);
  if (Number.isNaN(timestamp)) return { ok: false, reason: 'missing_timestamp' };

  const now = args.now ?? Date.now();
  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_DRIFT_MS) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const signedString = `${args.method}${args.uri}${args.rawBody}${args.timestampHeader}`;
  const expected = createHmac('sha256', args.clientSecret).update(signedString, 'utf8').digest('base64');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(args.signatureHeader, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}

/**
 * HubSpot delivers an array of event objects. We dedup by `eventId`
 * (a numeric ID unique per delivery) using the webhook_events table.
 */
const HubspotEventSchema = z.object({
  eventId: z.number(),
  subscriptionType: z.string(),
  objectId: z.number().optional(),
  occurredAt: z.number().optional(),
  changeSource: z.string().optional(),
});

const HubspotEventsArraySchema = z.array(HubspotEventSchema);

export interface RecordEventArgs {
  source: 'hubspot';
  eventId: string;
  payload: unknown;
}

export interface RecordEventOutcome {
  duplicate: boolean;
}

/**
 * Insert a webhook event for dedup. Returns `duplicate: true` if the same
 * eventId has already been received.
 */
export async function recordWebhookEvent(
  args: RecordEventArgs,
): Promise<RecordEventOutcome> {
  const result = await pool.query(
    `INSERT INTO webhook_events (event_id, source, payload, status)
     VALUES ($1, $2, $3::jsonb, 'received')
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [args.eventId, args.source, JSON.stringify(args.payload)],
  );
  return { duplicate: result.rowCount === 0 };
}

export async function markEventProcessed(eventId: string): Promise<void> {
  await pool.query(
    `UPDATE webhook_events SET status='processed', processed_at=NOW() WHERE event_id=$1`,
    [eventId],
  );
}

export async function markEventFailed(eventId: string, errorMessage: string): Promise<void> {
  await pool.query(
    `UPDATE webhook_events SET status='failed', processed_at=NOW(),
     payload = jsonb_set(payload, '{__error}', to_jsonb($2::text))
     WHERE event_id=$1`,
    [eventId, errorMessage],
  );
}

export async function processHubspotWebhook(rawPayload: unknown): Promise<{ accepted: number; duplicates: number; invalid: number }> {
  const parsed = HubspotEventsArraySchema.safeParse(rawPayload);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues }, 'hubspot_webhook_invalid_payload');
    return { accepted: 0, duplicates: 0, invalid: 1 };
  }

  let accepted = 0;
  let duplicates = 0;

  for (const event of parsed.data) {
    const eventId = `hubspot:${event.eventId}`;
    const { duplicate } = await recordWebhookEvent({
      source: 'hubspot',
      eventId,
      payload: event,
    });
    if (duplicate) {
      duplicates++;
      continue;
    }

    // For Phase 3: dedup is the contract we need to prove. Re-fetch of the
    // changed record happens via the next scheduled sync (which picks up
    // the new hs_lastmodifieddate). Phase 6 may add inline fetch+upsert here.
    await markEventProcessed(eventId);
    accepted++;
  }

  return { accepted, duplicates, invalid: 0 };
}
