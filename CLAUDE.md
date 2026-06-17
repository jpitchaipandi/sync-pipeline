# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                 # tsx watch mode on $PORT (default 3000)
npm run build               # tsc + copies src/db/migrations/*.sql into dist/
npm start                   # run compiled dist/index.js (production)
npm run migrate             # apply pending SQL migrations (tracked in schema_migrations)
npm run migrate:prod        # same, but from compiled dist/ (used in Render build step)
npm run typecheck           # tsc --noEmit
npm run lint                # ESLint over *.ts (no eslint config currently checked in)
npm test                    # vitest run (one-shot)
npm run test:watch          # vitest in watch mode

# Run a single test file
npx vitest run src/core/idempotency.test.ts

# Run a single test by name
npx vitest run -t "skip-if-unchanged"
```

Node version is pinned to `>=20.0.0 <21` via `engines`. The project is ESM (`"type": "module"`), so internal imports use the `.js` extension even though the source is `.ts` (e.g. `import { foo } from './bar.js'`). The build step copies migration SQL files into `dist/` because they are read at runtime by `src/db/migrate.ts`.

## Database connections

Two URLs, used in different contexts:

- `DATABASE_URL` — Neon **pooled** (port 6543, pgbouncer). Used by `src/db/client.ts` for all runtime queries and by pg-boss.
- `DATABASE_URL_DIRECT` — Neon **direct** (port 5432). Used **only** by `src/db/migrate.ts` because DDL doesn't play well with pgbouncer's transaction pooling.

`src/config/env.ts` loads `.env.local` first, then `.env`. In production (Render), neither file exists — env vars come from the dashboard.

## Architecture

Everything is organised around a **per-source adapter** pattern that the orchestrator drives uniformly. To understand a change that crosses sources, you need to read these files together:

- `src/sources/types.ts` — defines `SourceClient` (the adapter interface) and `NormalizedRecord`. Every source implements `fetchRecords(ctx): AsyncIterable<NormalizedRecord>` + `getNextCursor()`.
- `src/core/sync-orchestrator.ts` — single entry point (`runSource`) that opens a `sync_runs` row, iterates the client's records, upserts each one, and persists the new cursor. Sources are registered into an in-memory `Map` at boot via `registerSourceClient`.
- `src/index.ts` — wires up the adapters conditionally based on which env vars are present (HubSpot/GCal/Notion can each be disabled by simply not setting their credentials).
- `src/sources/{hubspot,google-calendar,notion}/` — each contains a `client.ts` (HTTP), `mapper.ts` (raw → `NormalizedRecord`), `sync.ts` (cursor-aware fetcher), `webhook.ts` if applicable, and `index.ts` that calls `registerSourceClient`.

### Idempotency (read `src/core/idempotency.ts`)

All writes go through `upsertRecord`. The SQL `ON CONFLICT ... WHERE records.payload_hash != EXCLUDED.payload_hash` clause is **load-bearing**: it makes repeated upserts of the same payload a no-op (zero writes, no `synced_at` churn). `computePayloadHash` produces a canonical SHA-256 by recursively sorting object keys — preserving this canonicalisation is essential, because changing it would invalidate every existing hash and force a full re-sync. The skip-if-unchanged guard is what makes overlapping incremental + backfill syncs safe.

### Stale cursor recovery

Each source's `sync.ts` throws `CursorExpiredError` (defined in `src/core/errors.ts`) when the source rejects its cursor (HubSpot 400 `INVALID_PAGINATION_TOKEN`, Google Calendar 410 `GONE`, Notion analogues). The orchestrator catches it and calls `cursorStore.markNeedsFullBackfill`, which sets `sync_state.needs_full_backfill = TRUE` and nulls the cursor. The skip-if-unchanged upsert covers the overlap window without double-counting. Do not "fix" `CursorExpiredError` by retrying inside the source — it must propagate to the orchestrator.

`src/core/backfill-scheduler.ts` exports `scheduleBackfills()` which reads the `needs_full_backfill` flag and enqueues `full` jobs, **but it is not currently called from anywhere** (no `grep` hits outside its own file). Recovery from a flagged source is therefore manual today: `POST /sync/:source?mode=full`. If you wire up automatic recovery, the natural place is at the start of each cron tick (before the `/sync/all` enqueue) or inside the worker on a dedicated schedule.

### Trigger → queue → worker → orchestrator flow

This is the path a sync actually takes; reading the route alone is misleading.

1. `POST /sync/all` (or `/sync/:source`) in `src/api/routes/sync.ts` calls `enqueueSync` once per source — `/sync/all` does this **in parallel** via `Promise.all`, then returns 202 with just `{ source, jobId, queued }` per source. The route itself does **not** wait for sync results.
2. `enqueueSync` (`src/jobs/sync-job.ts`) uses pg-boss `singletonKey: "<source>:<mode>"` — at most one job per (source, mode) is active at a time, so cron + webhook + manual triggers all collapse to a single in-flight run. When a singleton blocks the enqueue, `enqueueSync` returns `null` and the route returns 409 `SYNC_ALREADY_RUNNING`.
3. The worker registered by `registerSyncWorker` (same file) consumes jobs and calls `runSource` per job.
4. **Failure isolation lives inside `runSource`**, not at the route. Each call has its own try/catch and its own Cockatiel policy; a thrown error updates only that source's `sync_state` row and returns a failed `RunSourceOutcome`. Other sources' jobs are unaffected.

The README's pretty per-source `records_upserted` JSON shows orchestrator output, not what `/sync/all` returns today — don't update the route to match the README without an explicit ask.

### Resilience (read `src/core/resilience.ts`)

`createSourcePolicy(sourceId)` returns a Cockatiel policy stack: `bulkhead(3, 10) → circuitBreaker(5 consecutive, 30s) → retry(3 attempts, exponential)`. The retry layer explicitly **does not** retry `CursorExpiredError` or `PayloadValidationError` — those are terminal errors the orchestrator must see directly. When adding a new terminal error class, also add it to the `handleWhen` predicate in `createSourcePolicy`.

### Service boot order

`src/index.ts` calls `cleanupStaleRuns()` (invokes the `cleanup_stale_runs()` SQL function from `migrations/003`) **before** registering routes. Render's free tier spins the service down after 15 minutes idle; if a sync was mid-flight when the previous instance died, this function marks `sync_runs.status='running'` rows older than 30 minutes as `failed` and releases their `sync_state` locks. Always preserve this ordering — registering routes before cleanup would let traffic hit half-recovered state.

### Job queue

`src/jobs/queue.ts` (pg-boss) and `src/jobs/sync-job.ts` provide a Postgres-native worker. The `/sync/all` route enqueues jobs that the same process consumes (single-instance Render free tier). pg-boss creates its own `pgboss.*` schema on first start — do not version-control migrations for it. The `singletonKey` discussed above is how at-most-one-active enforcement is achieved; if you ever introduce per-tenant or per-entity sub-syncs, the singleton key has to incorporate the new dimension or distinct work will silently collapse into one job.

### Cron entry point

`src/cron-runner.ts` is a **separate, standalone** entry point that does NOT import the web service's DB client, queue, or orchestrator. It only does `fetch(...)` against the deployed web service. This separation matters: it lets the cron job run on a different process/plan from the web service. Do not collapse it into the main service.

The **production deployment does not actually run this script** — Render's free tier doesn't include cron, so scheduling is done externally on cron-job.org with a `POST /sync/all` + `Authorization: Bearer <API_SECRET>` (see `render.yaml` comment block). `cron-runner.ts` is kept around for ad-hoc invocation and other CI providers (GitHub Actions, Vercel cron, paid Render plan, etc.). When updating the production schedule, change cron-job.org — not anything in this repo.

### Webhooks (`src/api/routes/webhooks.ts`)

Two non-obvious rules live here:

- **HubSpot endpoint never returns 5xx.** Only 200 (processed or queued) or 401 (signature mismatch). HubSpot disables endpoints that return server errors, so processing failures are logged but the response is still 200. Preserve this contract — wrap new logic in try/catch and surface failures through logs and `sync_runs`, not HTTP status.
- **HubSpot HMAC v3 is verified against a re-stringified body, not the raw bytes.** Fastify parses JSON into `req.body` by default; the route calls `JSON.stringify(req.body)` and feeds that into the signature check. The inline code comment notes this only works because HubSpot sends compact JSON without whitespace — if a future verification mismatch appears, switch to `fastify-raw-body` and verify against the original bytes instead of patching the canonicalization.

Google Calendar push notifications carry no payload — the route only verifies the static `X-Goog-Channel-Token`, dedups by `(resourceId, messageNumber)`, and enqueues an incremental sync. The actual data delta arrives via the stored `syncToken` on the next fetch.

### Auth

`src/api/plugins/auth.ts` is a Fastify plugin (wrapped with `fastify-plugin` so the `preHandler` hook applies to the parent scope). Compares the Bearer token with `timingSafeEqual` — when extending, do not switch to `===` or substring comparison. Webhook routes have their own per-source verification (HubSpot HMAC v3, Google channel ID) and intentionally do not use this plugin.

## Conventions

- Internal imports use `.js` extensions (ESM requirement) even though sources are `.ts`.
- Response shape is always `{ success: true, data: T }` or `{ success: false, error: { code, message } }`. The Fastify `setErrorHandler` in `src/index.ts` enforces this for unhandled errors.
- All env access goes through `src/config/env.ts` (zod-validated). Don't read `process.env.*` directly outside `cron-runner.ts` (which is intentionally standalone).
- Logging uses Pino with secret redaction (`src/core/logger.ts`). Use structured fields (`logger.info({ source, runId }, 'event_name')`), not interpolated strings.
- Tests are colocated as `*.test.ts` next to the source and run in Node environment (no DOM).
- New SQL migrations go in `src/db/migrations/NNN_description.sql` with a zero-padded sequence prefix; the runner applies them in lexicographic order and records each in `schema_migrations`.
