import type { Pool, PoolClient } from 'pg';
import type { SourceId } from '../sources/types.js';

export type SyncStatus = 'idle' | 'running' | 'failed';

export interface SyncStateRow {
  source: SourceId;
  cursor: string | null;
  cursorType: string;
  lastIncrementalAt: Date | null;
  lastFullAt: Date | null;
  needsFullBackfill: boolean;
  status: SyncStatus;
  lockAcquiredAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  updatedAt: Date;
}

interface SyncStateColumns {
  source: SourceId;
  cursor: string | null;
  cursor_type: string;
  last_incremental_at: Date | null;
  last_full_at: Date | null;
  needs_full_backfill: boolean;
  status: SyncStatus;
  lock_acquired_at: Date | null;
  consecutive_failures: number;
  last_error: string | null;
  updated_at: Date;
}

function rowToSyncState(row: SyncStateColumns): SyncStateRow {
  return {
    source: row.source,
    cursor: row.cursor,
    cursorType: row.cursor_type,
    lastIncrementalAt: row.last_incremental_at,
    lastFullAt: row.last_full_at,
    needsFullBackfill: row.needs_full_backfill,
    status: row.status,
    lockAcquiredAt: row.lock_acquired_at,
    consecutiveFailures: row.consecutive_failures,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export async function getSyncState(
  client: Pool | PoolClient,
  source: SourceId,
): Promise<SyncStateRow | null> {
  const result = await client.query<SyncStateColumns>(
    'SELECT * FROM sync_state WHERE source = $1',
    [source],
  );
  return result.rows.length > 0 ? rowToSyncState(result.rows[0]!) : null;
}

export async function getAllSyncStates(
  client: Pool | PoolClient,
): Promise<SyncStateRow[]> {
  const result = await client.query<SyncStateColumns>(
    'SELECT * FROM sync_state ORDER BY source',
  );
  return result.rows.map(rowToSyncState);
}

export async function getCursor(
  client: Pool | PoolClient,
  source: SourceId,
): Promise<string | null> {
  const result = await client.query<{ cursor: string | null }>(
    'SELECT cursor FROM sync_state WHERE source = $1',
    [source],
  );
  return result.rows[0]?.cursor ?? null;
}

export async function setCursor(
  client: Pool | PoolClient,
  source: SourceId,
  cursor: string | null,
  mode: 'incremental' | 'full',
): Promise<void> {
  const timestampColumn = mode === 'incremental' ? 'last_incremental_at' : 'last_full_at';
  await client.query(
    `UPDATE sync_state
     SET cursor = $1,
         ${timestampColumn} = NOW(),
         updated_at = NOW()
     WHERE source = $2`,
    [cursor, source],
  );
}

export async function markNeedsFullBackfill(
  client: Pool | PoolClient,
  source: SourceId,
): Promise<void> {
  await client.query(
    `UPDATE sync_state
     SET needs_full_backfill = TRUE,
         cursor = NULL,
         updated_at = NOW()
     WHERE source = $1`,
    [source],
  );
}

export async function clearBackfillFlag(
  client: Pool | PoolClient,
  source: SourceId,
): Promise<void> {
  await client.query(
    `UPDATE sync_state
     SET needs_full_backfill = FALSE,
         updated_at = NOW()
     WHERE source = $1`,
    [source],
  );
}

export async function transitionStatus(
  client: Pool | PoolClient,
  source: SourceId,
  status: SyncStatus,
  options: { lastError?: string | null; resetFailures?: boolean } = {},
): Promise<void> {
  const lastErrorClause = options.lastError !== undefined ? ', last_error = $3' : '';
  const failuresClause =
    status === 'failed'
      ? ', consecutive_failures = consecutive_failures + 1'
      : options.resetFailures
        ? ', consecutive_failures = 0'
        : '';
  const lockClause =
    status === 'running'
      ? ', lock_acquired_at = NOW()'
      : ', lock_acquired_at = NULL';

  const params: Array<string | null> = [status, source];
  if (options.lastError !== undefined) {
    params.push(options.lastError);
  }

  await client.query(
    `UPDATE sync_state
     SET status = $1${lockClause}${lastErrorClause}${failuresClause},
         updated_at = NOW()
     WHERE source = $2`,
    params,
  );
}

export async function getSourcesNeedingBackfill(
  client: Pool | PoolClient,
): Promise<SourceId[]> {
  const result = await client.query<{ source: SourceId }>(
    `SELECT source FROM sync_state WHERE needs_full_backfill = TRUE ORDER BY source`,
  );
  return result.rows.map((r) => r.source);
}
