import { type calendar_v3, google } from 'googleapis';
import { env } from '../../config/env.js';
import { CursorExpiredError, SourceApiError } from '../../core/errors.js';

let cachedCalendar: calendar_v3.Calendar | null = null;

function getCalendar(): calendar_v3.Calendar {
  if (cachedCalendar) return cachedCalendar;
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error('Google OAuth env vars (CLIENT_ID/SECRET/REFRESH_TOKEN) not configured');
  }
  const oauth2 = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });
  cachedCalendar = google.calendar({ version: 'v3', auth: oauth2 });
  return cachedCalendar;
}

function extractStatus(err: unknown): number {
  const e = err as { code?: number; status?: number; response?: { status?: number } };
  return e?.code ?? e?.status ?? e?.response?.status ?? 0;
}

function extractMessage(err: unknown): string {
  const e = err as { message?: string; errors?: Array<{ message?: string }> };
  return e?.errors?.[0]?.message ?? e?.message ?? 'unknown Google Calendar error';
}

export interface ListResult {
  /** Yielded events; consumer reads via async iteration. */
  items: AsyncIterable<calendar_v3.Schema$Event>;
  /** Resolves AFTER iteration completes; the sync token to persist. */
  getNextSyncToken(): string | null;
}

/**
 * Iterate events from Google Calendar, paginating internally.
 *
 * - `syncToken` mode: incremental. Throws CursorExpiredError on either
 *   HTTP 410 (documented expired-token response) OR HTTP 400 with the
 *   message "Invalid sync token value." (Google's response to a
 *   malformed token — not documented but observed in practice).
 * - `null` syncToken: full sync. Captures the final `nextSyncToken` to
 *   persist as the new cursor.
 *
 * Within a single sync run, `nextSyncToken` appears only on the final
 * page; intermediate pages return `nextPageToken` for pagination.
 */
export function listEvents(args: { syncToken: string | null; signal?: AbortSignal }): ListResult {
  let nextSyncToken: string | null = null;
  const calendarId = env.GOOGLE_CALENDAR_ID;

  async function* iterate(): AsyncIterable<calendar_v3.Schema$Event> {
    const cal = getCalendar();
    let pageToken: string | undefined;

    while (true) {
      if (args.signal?.aborted) return;

      // Build the request. syncToken and most other filters are mutually
      // exclusive: when syncToken is present we must NOT pass timeMin,
      // timeMax, q, etc. (Google returns 400 otherwise).
      const params: calendar_v3.Params$Resource$Events$List = {
        calendarId,
        maxResults: 250,
        showDeleted: true,
        singleEvents: false,
      };
      if (args.syncToken) params.syncToken = args.syncToken;
      if (pageToken) params.pageToken = pageToken;

      let response;
      try {
        response = await cal.events.list(params);
      } catch (err) {
        const status = extractStatus(err);
        const message = extractMessage(err);
        // Google signals an invalid syncToken two different ways depending
        // on what's wrong with it:
        //   - 410 Gone: well-formed token, server has invalidated it (TTL
        //     elapsed, ACL changed). Documented.
        //   - 400 Bad Request "Invalid sync token value.": token is
        //     malformed (random string, corrupted character, truncated).
        //     Empirically observed; not as documented but very real.
        // Both mean the same thing for our state machine: the cursor is
        // unusable, fall back to a full backfill.
        const isInvalidSyncToken =
          status === 410 ||
          (status === 400 && /sync.?token/i.test(message));
        if (isInvalidSyncToken) {
          throw new CursorExpiredError('google-calendar', {
            syncToken: args.syncToken,
            status,
            message,
          });
        }
        throw new SourceApiError('google-calendar', status, message);
      }

      const data = response.data;
      for (const item of data.items ?? []) {
        yield item;
      }

      if (data.nextSyncToken) {
        nextSyncToken = data.nextSyncToken;
      }
      if (!data.nextPageToken) return;
      pageToken = data.nextPageToken;
    }
  }

  return {
    items: iterate(),
    getNextSyncToken: () => nextSyncToken,
  };
}
