export type SourceId = 'hubspot' | 'google-calendar' | 'notion';

export type SyncMode = 'incremental' | 'full';

export interface NormalizedRecord {
  source: SourceId;
  sourceRecordId: string;
  entityType: string;
  payload: Record<string, unknown>;
  sourceUpdatedAt: Date | null;
}

export interface FetchContext {
  cursor: string | null;
  mode: SyncMode;
  signal?: AbortSignal;
}

/**
 * Per-source adapter. Phase 2 defines the shape; concrete implementations
 * (HubSpot, Google Calendar, Notion) ship in Phases 3-5. The orchestrator
 * looks up a SourceClient by id and gracefully fails the sync run with
 * `NO_CLIENT_REGISTERED` when one is not yet wired in.
 */
export interface SourceClient {
  readonly id: SourceId;

  /**
   * Iterate records from the source, handling pagination internally.
   * Throws CursorExpiredError when the source rejects the cursor as stale
   * (HubSpot 400 INVALID_PAGINATION_TOKEN, Google Calendar 410 GONE, etc.).
   */
  fetchRecords(ctx: FetchContext): AsyncIterable<NormalizedRecord>;

  /**
   * Returns the cursor value to persist in `sync_state.cursor` after a
   * successful fetchRecords completion. Must be called AFTER iteration
   * finishes. Returns null when the source has no high-water mark yet
   * (e.g., very first full sync against an empty source).
   */
  getNextCursor(): string | null;
}

export interface SyncRunResult {
  recordsSeen: number;
  recordsUpserted: number;
  recordsSkipped: number;
  recordsFailed: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  errors: Array<{ recordId?: string; message: string }>;
}
