import type { FetchContext, NormalizedRecord, SourceClient } from '../types.js';
import { listAll, searchSince } from './client.js';
import { type HubspotEntityType, mapHubspotObject } from './mapper.js';

const ENTITY_TYPES: HubspotEntityType[] = ['contact', 'company', 'deal'];

/**
 * HubSpot SourceClient. Yields contacts, then companies, then deals.
 *
 * Cursor format: a string of epoch milliseconds — the maximum
 * `hs_lastmodifieddate` seen across all yielded records. Steady-state
 * incremental syncs use the CRM Search API filtered by
 * `hs_lastmodifieddate GTE cursor`. Full syncs use the basic list API
 * which paginates over all records (bypassing the Search API 10k cap).
 *
 * If a sync yields zero new records, the cursor is preserved unchanged so
 * we don't lose ground.
 */
export class HubspotSourceClient implements SourceClient {
  readonly id = 'hubspot' as const;
  private nextCursor: string | null = null;

  async *fetchRecords(ctx: FetchContext): AsyncIterable<NormalizedRecord> {
    const { cursor, mode, signal } = ctx;
    const sinceMs = parseCursor(cursor);
    let maxModified = sinceMs;

    for (const entityType of ENTITY_TYPES) {
      if (signal?.aborted) break;

      const stream =
        mode === 'full'
          ? listAll(entityType, signal)
          : searchSince(entityType, sinceMs, signal);

      for await (const raw of stream) {
        const record = mapHubspotObject(entityType, raw);
        if (record.sourceUpdatedAt) {
          const ms = record.sourceUpdatedAt.getTime();
          if (ms > maxModified) maxModified = ms;
        }
        yield record;
      }
    }

    // Preserve prior cursor if we yielded nothing new this run.
    this.nextCursor = maxModified > 0 ? String(maxModified) : cursor;
  }

  getNextCursor(): string | null {
    return this.nextCursor;
  }
}

function parseCursor(cursor: string | null): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid HubSpot cursor (expected epoch ms): ${cursor}`);
  }
  return n;
}
