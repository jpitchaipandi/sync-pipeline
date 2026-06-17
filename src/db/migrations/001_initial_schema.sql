-- Initial schema for sync-pipeline.
-- Idempotent: safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- sources: registry of known integration sources
-- ============================================================
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT        PRIMARY KEY,
  display_name  TEXT        NOT NULL,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- sync_state: per-source cursor + status
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_state (
  source                TEXT        PRIMARY KEY REFERENCES sources(id),
  cursor                TEXT,
  cursor_type           TEXT        NOT NULL DEFAULT 'timestamp',
  last_incremental_at   TIMESTAMPTZ,
  last_full_at          TIMESTAMPTZ,
  needs_full_backfill   BOOLEAN     NOT NULL DEFAULT FALSE,
  status                TEXT        NOT NULL DEFAULT 'idle'
                        CHECK (status IN ('idle', 'running', 'failed')),
  lock_acquired_at      TIMESTAMPTZ,
  consecutive_failures  INTEGER     NOT NULL DEFAULT 0,
  last_error            TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- records: normalized landing table
-- ============================================================
CREATE TABLE IF NOT EXISTS records (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source             TEXT        NOT NULL REFERENCES sources(id),
  source_record_id   TEXT        NOT NULL,
  entity_type        TEXT        NOT NULL,
  payload            JSONB       NOT NULL,
  payload_hash       TEXT        NOT NULL,
  source_updated_at  TIMESTAMPTZ,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_deleted         BOOLEAN     NOT NULL DEFAULT FALSE,
  CONSTRAINT uq_record UNIQUE (source, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_records_source         ON records (source);
CREATE INDEX IF NOT EXISTS idx_records_entity_type    ON records (entity_type);
CREATE INDEX IF NOT EXISTS idx_records_source_updated ON records (source, source_updated_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_records_synced_at      ON records (synced_at DESC);

-- ============================================================
-- sync_runs: append-only audit log of every sync execution
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_runs (
  run_id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source            TEXT        NOT NULL REFERENCES sources(id),
  mode              TEXT        NOT NULL CHECK (mode IN ('incremental', 'full')),
  triggered_by      TEXT        NOT NULL DEFAULT 'cron',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  status            TEXT        NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'success', 'failed', 'partial')),
  records_seen      INTEGER     NOT NULL DEFAULT 0,
  records_upserted  INTEGER     NOT NULL DEFAULT 0,
  records_skipped   INTEGER     NOT NULL DEFAULT 0,
  records_failed    INTEGER     NOT NULL DEFAULT 0,
  error_summary     JSONB,
  cursor_before     TEXT,
  cursor_after      TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_source     ON sync_runs (source, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_runs_status     ON sync_runs (status);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at ON sync_runs (started_at DESC);

-- ============================================================
-- webhook_events: dedup store for incoming webhook deliveries
-- ============================================================
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id      TEXT        PRIMARY KEY,
  source        TEXT        NOT NULL REFERENCES sources(id),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  payload       JSONB       NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'received'
                CHECK (status IN ('received', 'processing', 'processed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_source    ON webhook_events (source, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_pending   ON webhook_events (status) WHERE status != 'processed';
