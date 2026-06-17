import { z } from 'zod';
import { PayloadValidationError } from '../../core/errors.js';
import type { NormalizedRecord } from '../types.js';

const TimePointSchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
});

/**
 * Subset of the Google Calendar Event resource we care about. The full
 * Event is large; we capture identity, time, lifecycle, and human-readable
 * fields. Cancelled events come back with `status === 'cancelled'` and
 * minimal other fields — the schema makes most fields optional to handle
 * both cases.
 */
const CalendarEventSchema = z.object({
  id: z.string().min(1),
  iCalUID: z.string().optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: TimePointSchema.optional(),
  end: TimePointSchema.optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: TimePointSchema.optional(),
  organizer: z.object({ email: z.string().optional(), displayName: z.string().optional() }).optional(),
  htmlLink: z.string().optional(),
  attendees: z
    .array(
      z.object({
        email: z.string().optional(),
        responseStatus: z.string().optional(),
        displayName: z.string().optional(),
      }),
    )
    .optional(),
});

export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

/**
 * Map a Google Calendar event to a NormalizedRecord.
 *
 * - All-day events come with `start.date` (YYYY-MM-DD) instead of
 *   `start.dateTime`. The payload preserves both shapes; downstream
 *   consumers can detect via `start.date` presence.
 * - Cancelled events (`status === 'cancelled'`) are still upserted so
 *   that consumers can see the cancellation. Hard deletion happens
 *   separately if ever required.
 * - `iCalUID` is preserved in payload but `sourceRecordId` uses `id`
 *   because it's the calendar-scoped stable identifier the sync API
 *   keys off.
 */
export function mapCalendarEvent(raw: unknown): NormalizedRecord {
  const parsed = CalendarEventSchema.safeParse(raw);
  if (!parsed.success) {
    const id = (raw as { id?: unknown })?.id;
    throw new PayloadValidationError(
      'google-calendar',
      typeof id === 'string' ? id : 'unknown',
      parsed.error.issues,
    );
  }

  const event = parsed.data;
  const updatedAt = event.updated ? new Date(event.updated) : null;

  return {
    source: 'google-calendar',
    sourceRecordId: event.id,
    entityType: 'event',
    payload: {
      id: event.id,
      iCalUID: event.iCalUID ?? null,
      status: event.status ?? null,
      summary: event.summary ?? null,
      description: event.description ?? null,
      location: event.location ?? null,
      start: event.start ?? null,
      end: event.end ?? null,
      created: event.created ?? null,
      updated: event.updated ?? null,
      recurringEventId: event.recurringEventId ?? null,
      originalStartTime: event.originalStartTime ?? null,
      organizer: event.organizer ?? null,
      htmlLink: event.htmlLink ?? null,
      attendees: event.attendees ?? null,
    },
    sourceUpdatedAt: updatedAt,
  };
}
