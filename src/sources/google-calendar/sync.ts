import type { FetchContext, NormalizedRecord, SourceClient } from '../types.js';
import { listEvents } from './client.js';
import { mapCalendarEvent } from './mapper.js';

/**
 * Google Calendar SourceClient.
 *
 * Cursor: an opaque `syncToken` string returned by Google. The token is
 * server-side state, not a timestamp we compute. On HTTP 410 the token
 * is considered expired; CursorExpiredError surfaces to the orchestrator
 * which flips `needs_full_backfill`, clears the cursor, and the next
 * mode=full run rebuilds state via a no-syncToken list.
 *
 * Full sync: omits syncToken, iterates all pages, captures the final
 * `nextSyncToken` to use for subsequent incrementals.
 */
export class GoogleCalendarSourceClient implements SourceClient {
  readonly id = 'google-calendar' as const;
  private nextCursor: string | null = null;

  async *fetchRecords(ctx: FetchContext): AsyncIterable<NormalizedRecord> {
    const useSyncToken = ctx.mode === 'incremental' && ctx.cursor !== null;
    const args: { syncToken: string | null; signal?: AbortSignal } = {
      syncToken: useSyncToken ? ctx.cursor : null,
    };
    if (ctx.signal) {
      args.signal = ctx.signal;
    }
    const result = listEvents(args);

    for await (const event of result.items) {
      yield mapCalendarEvent(event);
    }

    // Preserve prior cursor if Google didn't issue a new one (rare —
    // happens only when no pages were fetched).
    this.nextCursor = result.getNextSyncToken() ?? ctx.cursor;
  }

  getNextCursor(): string | null {
    return this.nextCursor;
  }
}
