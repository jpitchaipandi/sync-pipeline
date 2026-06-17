import { pool } from '../db/client.js';
import { logger } from './logger.js';
import { upsertRecord } from './idempotency.js';
import * as cursorStore from './cursor-store.js';
import { CursorExpiredError } from './errors.js';
import type {
  SourceClient,
  SourceId,
  SyncMode,
  SyncRunResult,
} from '../sources/types.js';

const clients = new Map<SourceId, SourceClient>();

/**
 * Phases 3-5 each call this at module load to register a concrete client.
 * The orchestrator looks up clients by id and gracefully fails the sync run
 * with `NO_CLIENT_REGISTERED` when none is found.
 */
export function registerSourceClient(client: SourceClient): void {
  clients.set(client.id, client);
  logger.info({ source: client.id }, 'source_client_registered');
}

export function getRegisteredSources(): SourceId[] {
  return Array.from(clients.keys());
}

export function unregisterAllClients(): void {
  clients.clear();
}

export interface RunSourceArgs {
  source: SourceId;
  mode: SyncMode;
  triggeredBy?: string;
}

export interface RunSourceOutcome {
  runId: string;
  source: SourceId;
  status: 'success' | 'partial' | 'failed';
  result: SyncRunResult;
}

export async function runSource(args: RunSourceArgs): Promise<RunSourceOutcome> {
  const triggeredBy = args.triggeredBy ?? 'manual';

  const runRow = await pool.query<{ run_id: string }>(
    `INSERT INTO sync_runs (source, mode, triggered_by, status)
     VALUES ($1, $2, $3, 'running')
     RETURNING run_id`,
    [args.source, args.mode, triggeredBy],
  );
  const runId = runRow.rows[0]!.run_id;

  const log = logger.child({ source: args.source, runId, mode: args.mode });
  log.info('sync_run_started');

  await cursorStore.transitionStatus(pool, args.source, 'running');

  const cursorBefore = await cursorStore.getCursor(pool, args.source);

  const client = clients.get(args.source);
  if (!client) {
    log.warn('no_source_client_registered');
    const errors: SyncRunResult['errors'] = [
      { message: `No SourceClient registered for "${args.source}"` },
    ];
    await pool.query(
      `UPDATE sync_runs
       SET status='failed', ended_at=NOW(),
           cursor_before=$1, error_summary=$2::jsonb
       WHERE run_id=$3`,
      [cursorBefore, JSON.stringify(errors), runId],
    );
    await cursorStore.transitionStatus(pool, args.source, 'idle', {
      lastError: 'NO_CLIENT_REGISTERED',
    });
    return {
      runId,
      source: args.source,
      status: 'failed',
      result: {
        recordsSeen: 0,
        recordsUpserted: 0,
        recordsSkipped: 0,
        recordsFailed: 0,
        cursorBefore,
        cursorAfter: cursorBefore,
        errors,
      },
    };
  }

  let recordsSeen = 0;
  let recordsUpserted = 0;
  let recordsSkipped = 0;
  let recordsFailed = 0;
  const errors: SyncRunResult['errors'] = [];

  try {
    const fetchCursor = args.mode === 'incremental' ? cursorBefore : null;

    for await (const record of client.fetchRecords({
      cursor: fetchCursor,
      mode: args.mode,
    })) {
      recordsSeen++;
      try {
        const { written } = await upsertRecord(pool, record);
        if (written) recordsUpserted++;
        else recordsSkipped++;
      } catch (err) {
        recordsFailed++;
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ recordId: record.sourceRecordId, message });
        log.error({ err, recordId: record.sourceRecordId }, 'upsert_failed');
      }
    }

    const cursorAfter = client.getNextCursor();
    await cursorStore.setCursor(pool, args.source, cursorAfter, args.mode);
    if (args.mode === 'full') {
      await cursorStore.clearBackfillFlag(pool, args.source);
    }

    const status: 'success' | 'partial' = recordsFailed > 0 ? 'partial' : 'success';
    await pool.query(
      `UPDATE sync_runs
       SET status=$1, ended_at=NOW(),
           records_seen=$2, records_upserted=$3,
           records_skipped=$4, records_failed=$5,
           cursor_before=$6, cursor_after=$7,
           error_summary=$8::jsonb
       WHERE run_id=$9`,
      [
        status,
        recordsSeen,
        recordsUpserted,
        recordsSkipped,
        recordsFailed,
        cursorBefore,
        cursorAfter,
        errors.length ? JSON.stringify(errors) : null,
        runId,
      ],
    );
    await cursorStore.transitionStatus(pool, args.source, 'idle', {
      resetFailures: true,
    });
    log.info(
      { recordsSeen, recordsUpserted, recordsSkipped, recordsFailed, status },
      'sync_run_complete',
    );

    return {
      runId,
      source: args.source,
      status,
      result: {
        recordsSeen,
        recordsUpserted,
        recordsSkipped,
        recordsFailed,
        cursorBefore,
        cursorAfter,
        errors,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isCursorExpired = err instanceof CursorExpiredError;

    if (isCursorExpired) {
      log.warn({ err }, 'cursor_expired_scheduling_backfill');
      await cursorStore.markNeedsFullBackfill(pool, args.source);
    }

    errors.push({ message });
    await pool.query(
      `UPDATE sync_runs
       SET status='failed', ended_at=NOW(),
           records_seen=$1, records_upserted=$2, records_skipped=$3, records_failed=$4,
           cursor_before=$5, error_summary=$6::jsonb
       WHERE run_id=$7`,
      [
        recordsSeen,
        recordsUpserted,
        recordsSkipped,
        recordsFailed,
        cursorBefore,
        JSON.stringify(errors),
        runId,
      ],
    );
    await cursorStore.transitionStatus(pool, args.source, 'failed', {
      lastError: message,
    });
    log.error({ err, recordsSeen }, 'sync_run_failed');

    return {
      runId,
      source: args.source,
      status: 'failed',
      result: {
        recordsSeen,
        recordsUpserted,
        recordsSkipped,
        recordsFailed: recordsFailed + 1,
        cursorBefore,
        cursorAfter: cursorBefore,
        errors,
      },
    };
  }
}
