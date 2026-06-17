import type { FetchContext, NormalizedRecord, SourceClient } from '../types.js';
import { queryDatabase } from './client.js';
import { mapNotionPage } from './mapper.js';

/**
 * Notion SourceClient. Polling-only — Notion has no native webhooks
 * (a public webhook API exists but isn't usable with internal integrations
 * the way we set it up).
 *
 * Cursor: ISO timestamp string of the max `last_edited_time` seen.
 * Incremental uses `last_edited_time on_or_after` filter.
 * Full omits the filter and returns the entire database.
 *
 * No CursorExpiredError path — Notion timestamps don't expire.
 */
export class NotionSourceClient implements SourceClient {
  readonly id = 'notion' as const;
  private nextCursor: string | null = null;

  async *fetchRecords(ctx: FetchContext): AsyncIterable<NormalizedRecord> {
    const sinceIso = ctx.mode === 'incremental' ? ctx.cursor : null;
    let maxIso: string | null = sinceIso;

    for await (const raw of queryDatabase(sinceIso, ctx.signal)) {
      const record = mapNotionPage(raw);
      if (record.sourceUpdatedAt) {
        const iso = record.sourceUpdatedAt.toISOString();
        if (!maxIso || iso > maxIso) maxIso = iso;
      }
      yield record;
    }

    this.nextCursor = maxIso;
  }

  getNextCursor(): string | null {
    return this.nextCursor;
  }
}
