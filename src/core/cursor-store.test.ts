import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { closePool, pool } from '../db/client.js';
import {
  clearBackfillFlag,
  getAllSyncStates,
  getCursor,
  getSourcesNeedingBackfill,
  getSyncState,
  markNeedsFullBackfill,
  setCursor,
  transitionStatus,
} from './cursor-store.js';

describe('cursor-store', () => {
  let client: PoolClient;
  const source = 'hubspot' as const;

  beforeAll(async () => {
    const test = await pool.query('SELECT 1');
    expect(test.rowCount).toBe(1);
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    // Reset all sync_state rows to defaults inside the transaction so
    // committed state from earlier real syncs doesn't leak into assertions.
    await client.query(`
      UPDATE sync_state
      SET cursor = NULL,
          last_incremental_at = NULL,
          last_full_at = NULL,
          needs_full_backfill = FALSE,
          status = 'idle',
          lock_acquired_at = NULL,
          consecutive_failures = 0,
          last_error = NULL
    `);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  afterAll(async () => {
    await closePool();
  });

  it('returns null cursor for a freshly seeded source', async () => {
    expect(await getCursor(client, source)).toBeNull();
  });

  it('round-trips cursor via set/get', async () => {
    await setCursor(client, source, 'cursor-abc-123', 'incremental');
    expect(await getCursor(client, source)).toBe('cursor-abc-123');
  });

  it('setCursor with mode=incremental updates last_incremental_at', async () => {
    await setCursor(client, source, 'c1', 'incremental');
    const state = await getSyncState(client, source);
    expect(state?.lastIncrementalAt).toBeInstanceOf(Date);
    expect(state?.lastFullAt).toBeNull();
  });

  it('setCursor with mode=full updates last_full_at', async () => {
    await setCursor(client, source, 'c1', 'full');
    const state = await getSyncState(client, source);
    expect(state?.lastFullAt).toBeInstanceOf(Date);
    expect(state?.lastIncrementalAt).toBeNull();
  });

  it('markNeedsFullBackfill sets flag and clears cursor', async () => {
    await setCursor(client, source, 'some-cursor', 'incremental');
    await markNeedsFullBackfill(client, source);

    const state = await getSyncState(client, source);
    expect(state?.needsFullBackfill).toBe(true);
    expect(state?.cursor).toBeNull();
  });

  it('clearBackfillFlag resets needs_full_backfill', async () => {
    await markNeedsFullBackfill(client, source);
    await clearBackfillFlag(client, source);

    const state = await getSyncState(client, source);
    expect(state?.needsFullBackfill).toBe(false);
  });

  it('transitionStatus to running sets lock_acquired_at', async () => {
    await transitionStatus(client, source, 'running');
    const state = await getSyncState(client, source);
    expect(state?.status).toBe('running');
    expect(state?.lockAcquiredAt).toBeInstanceOf(Date);
  });

  it('transitionStatus to idle clears lock_acquired_at', async () => {
    await transitionStatus(client, source, 'running');
    await transitionStatus(client, source, 'idle', { resetFailures: true });

    const state = await getSyncState(client, source);
    expect(state?.status).toBe('idle');
    expect(state?.lockAcquiredAt).toBeNull();
    expect(state?.consecutiveFailures).toBe(0);
  });

  it('transitionStatus to failed increments consecutive_failures', async () => {
    await transitionStatus(client, source, 'failed', { lastError: 'first error' });
    await transitionStatus(client, source, 'failed', { lastError: 'second error' });

    const state = await getSyncState(client, source);
    expect(state?.status).toBe('failed');
    expect(state?.consecutiveFailures).toBe(2);
    expect(state?.lastError).toBe('second error');
  });

  it('getAllSyncStates returns all seeded sources', async () => {
    const states = await getAllSyncStates(client);
    const ids = states.map((s) => s.source).sort();
    expect(ids).toEqual(['google-calendar', 'hubspot', 'notion']);
  });

  it('getSourcesNeedingBackfill returns only flagged sources', async () => {
    expect(await getSourcesNeedingBackfill(client)).toEqual([]);

    await markNeedsFullBackfill(client, 'hubspot');
    await markNeedsFullBackfill(client, 'notion');

    const needing = await getSourcesNeedingBackfill(client);
    expect(needing.sort()).toEqual(['hubspot', 'notion']);
  });
});
