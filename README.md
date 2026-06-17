# Sync Pipeline

Multi-source sync pipeline that ingests records from **HubSpot CRM**, **Google Calendar**, and **Notion** into a single normalized Postgres schema. Designed around data correctness, idempotency, and failure handling.

## What it does

1. **Ingests incrementally** per source — cursor/timestamp-based fetching, with full-fetch fallback
2. **Recovers from stale cursors** — when HubSpot returns `400 INVALID_PAGINATION_TOKEN` or Google Calendar returns `410 GONE`, the pipeline automatically falls back to a full backfill instead of losing data
3. **Writes idempotently** — same record, same webhook firing twice, or back-to-back job re-runs never produce duplicate rows (natural-key upsert + content-hash skip-if-unchanged + webhook event dedup)
4. **Isolates failures** — one source erroring or returning garbage never wedges the other two; orchestrator runs each source in its own try/catch with its own resilience policy

## Architecture

| Concern | Choice | Why |
|---|---|---|
| HTTP framework | **Fastify** | Smaller cold-start footprint than NestJS on Render free tier; built-in schema validation; plugin system gives module structure without DI-framework overhead |
| Third source | **Notion** | Free API key, `last_edited_time` filter for clean incremental sync, document/page shape is genuinely different from CRM and calendar data |
| Database | **Neon Postgres (free)** | Render Postgres's free tier deletes data after 30 days — disqualifying for a portfolio project. Neon has no expiry, built-in PgBouncer, scale-to-zero auto-wakes in <1s |
| ORM | **Drizzle ORM + pg** | Type-safe SQL builder, native VIEW support, small bundle |
| Job queue | **pg-boss** | Postgres-native, no Redis required, `SKIP LOCKED` for exactly-once delivery |
| Resilience | **Cockatiel** | Composable retry + circuit breaker + bulkhead in one TypeScript-first library |
| Logging | **Pino** | Structured JSON, async writes, secret redaction |
| HTTP client | **got v14** | Retries, hooks, streams. *Avoid axios 1.14.1/0.30.4 — supply chain compromise March 2026* |
| Scheduling | **Render Cron Job** | Survives free-tier web service spin-down; one slot triggers `POST /sync/all`, one acts as keep-alive |

## Data Model

```sql
sources          -- registry: hubspot, google-calendar, notion (seeded at boot)
sync_state       -- one row per source: cursor, status, needs_full_backfill flag, advisory-lock metadata
records          -- normalized landing table; UNIQUE(source, source_record_id); payload + payload_hash
sync_runs        -- append-only audit log: started_at, ended_at, status, counters, error_summary
webhook_events   -- dedup store: event_id PK, status, payload
schema_migrations -- migration tracker; idempotent re-runs
```

The pipeline writes to `records` via:

```sql
INSERT INTO records (source, source_record_id, entity_type, payload, payload_hash, ...)
VALUES (...)
ON CONFLICT (source, source_record_id)
DO UPDATE SET payload = EXCLUDED.payload, payload_hash = EXCLUDED.payload_hash, ...
WHERE records.payload_hash != EXCLUDED.payload_hash;
```

The `WHERE` clause makes the upsert a no-op when content is unchanged — no `updated_at` churn, no wasted writes. This is the **skip-if-unchanged** idempotency pattern.

A `cleanup_stale_runs()` SQL function heals state left behind by Render's free-tier spin-down: any `sync_runs.status = 'running'` row older than 30 minutes is marked `failed` and its `sync_state` lock is released. Called at every service boot before traffic is accepted.

## Stale Cursor Recovery

Per-source state machine in `sync_state`:

```
incremental sync → fetches since cursor → upserts → updates cursor
                                                      ↓
                                            (cursor expires later)
                                                      ↓
incremental sync → throws CursorExpiredError → catch in orchestrator
                                                      ↓
                                  needs_full_backfill = TRUE, cursor = NULL
                                                      ↓
backfill scheduler (next cycle) → fires full sync → idempotent upsert covers overlap
                                                      ↓
                                  needs_full_backfill = FALSE, fresh cursor stored
```

No double-counting because the upsert's content-hash WHERE clause makes re-processing during transition a no-op at the record level.

## Failure Isolation

The orchestrator iterates sources sequentially. Each source runs in its own try/catch with its own Cockatiel policy stack (retry → circuit breaker → bulkhead). A failed source updates its own `sync_state.status = 'failed'` and the others run to completion. Result:

```json
{
  "success": true,
  "data": {
    "results": [
      { "source": "hubspot",         "status": "success", "records_upserted": 42 },
      { "source": "google-calendar", "status": "failed",  "error": { "code": "SOURCE_API_ERROR" } },
      { "source": "notion",          "status": "success", "records_upserted": 7 }
    ]
  }
}
```

## API Surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness + DB ping; returns 503 on DB failure |
| POST | `/sync/:source` | Bearer | Trigger incremental sync; `?mode=full` forces full backfill |
| POST | `/sync/all` | Bearer | Trigger all sources sequentially |
| GET | `/sync/status` | Bearer | Current `sync_state` per source |
| GET | `/sync/runs` | Bearer | Recent sync runs (filterable) |
| POST | `/webhooks/hubspot` | HMAC v3 | HubSpot webhook receiver — always returns 200 |
| POST | `/webhooks/google-calendar` | Channel ID | GCal push notification handler |
| GET | `/records` | Bearer | Query normalized records with filters |

All responses follow:

```typescript
// success
{ success: true, data: T }
// error
{ success: false, error: { code: string, message: string } }
```

## Local Setup

> For step-by-step setup of each external system (Neon, Render, HubSpot, Google Calendar, Notion, cron-job.org), see [`docs/guides/`](docs/guides/README.md).

### Prerequisites
- Node.js 20.x (`>=20.0.0 <21`)
- A Neon Postgres project (https://neon.tech, free tier) — see [guide-neon.md](docs/guides/guide-neon.md)

### Configure
```bash
cp .env.example .env.local
# Edit .env.local: paste DATABASE_URL (pooled, port 6543) and DATABASE_URL_DIRECT (direct, port 5432)
```

### Install, migrate, run
```bash
npm install
npm run migrate     # applies SQL files in src/db/migrations/ in order
npm run dev         # tsx watch mode on $PORT (default 3000)
```

### Verify
```bash
curl http://localhost:3000/health
# Expected: {"success":true,"data":{"status":"ok","db":"ok","uptime":...}}
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start in watch mode via `tsx` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm run migrate` | Apply pending SQL migrations (tracked in `schema_migrations`) |
| `npm test` | Run Vitest unit + integration tests |
| `npm run typecheck` | TypeScript only, no emit |
| `npm run lint` | ESLint over `*.ts` |

## Deployment

Deployed on Render free tier as a Blueprint (`render.yaml`):

- **Service:** Web Service, Free, Oregon, Node 20
- **Build:** `npm ci && npm run build && npm run migrate`
- **Start:** `npm start`
- **Health check:** `/health` (Render polls; returns to live state on 200)

Secrets set in the Render dashboard (not in the Blueprint):
- `DATABASE_URL` — Neon pooled URL (port 6543, pgbouncer)
- `DATABASE_URL_DIRECT` — Neon direct URL (port 5432, used only for migrations)
- `API_SECRET` — auto-generated by Render for management endpoint auth
- HubSpot / Google / Notion credentials are pasted in when each integration is wired up

### Scheduled syncs

Render's Cron Job service requires a paid plan; it isn't available on the free tier. The current deployment runs no automatic schedule — syncs are triggered manually via `POST /sync/all` (or per-source).

**Production path:** move to Render's paid Cron Job tier. The `render.yaml` Blueprint and `src/cron-runner.ts` script are already in place; only the Render plan needs to change.

**Free-tier alternative** (for portfolio / staging environments): an external cron service like cron-job.org pointed at `POST https://<service>/sync/all` with the `Authorization: Bearer <API_SECRET>` header. Free, configurable per-minute schedule.

The web service spins down after 15 minutes idle on Render free, so the first request after a quiet period takes ~30 s to cold-start.

## Project Structure

```
src/
├── index.ts                          ─ Fastify factory; runs cleanup_stale_runs() at boot
├── config/env.ts                     ─ Zod-validated env (loads .env.local via dotenv)
├── core/
│   ├── errors.ts                     ─ SyncError + typed subclasses
│   └── logger.ts                     ─ Pino with secret redaction
├── db/
│   ├── client.ts                     ─ pg.Pool + Drizzle instance + ping()
│   ├── migrate.ts                    ─ schema_migrations-tracked SQL runner
│   └── migrations/                   ─ 001 schema, 002 seed, 003 cleanup function
├── api/routes/
│   └── health.ts                     ─ GET /health
└── sources/                          ─ HubSpot / GCal / Notion adapters
```

## Sources & References

Research informing the design decisions in this project:

**HubSpot**
- [HubSpot API Usage Guidelines and Limits](https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines)
- [Introducing version 3 of Webhook signatures](https://developers.hubspot.com/changelog/introducing-version-3-of-webhook-signatures)
- [Guide to HubSpot Webhooks — Hookdeck](https://hookdeck.com/webhooks/platforms/guide-to-hubspot-webhooks-features-and-best-practices)

**Google Calendar**
- [Synchronize Resources Efficiently](https://developers.google.com/workspace/calendar/api/guides/sync)
- [Push Notifications Guide](https://developers.google.com/workspace/calendar/api/guides/push)
- [Usage Limits and Quota](https://developers.google.com/workspace/calendar/api/guides/quota)

**Notion**
- [Filter databases by timestamp](https://developers.notion.com/changelog/filter-databases-by-timestamp-even-if-they-dont-have-a-timestamp-property)

**Idempotency & resilience**
- [Idempotency: The Property That Will Save Your Pipelines](https://datainproduction.substack.com/p/idempotency-the-property-that-will)
- [Webhook Idempotency and Deduplication](https://www.hooklistener.com/learn/webhook-idempotency-and-deduplication)
- [Why Your Idempotency Implementation Is Silently Losing Data](https://dzone.com/articles/phantom-write-idempotency-data-loss)
- [Cockatiel: Resilience and Fault-Handling Library](https://github.com/connor4312/cockatiel)
- [pg-boss: Queueing Jobs in Postgres from Node.js](https://github.com/timgit/pg-boss)
- [API Resilience: Circuit Breakers, Retries, Bulkheads 2026](https://apiscout.dev/blog/api-resilience-circuit-breakers-retries-bulkheads-2026)
- [PostgreSQL advisory locks for distributed locking](https://rclayton.silvrback.com/distributed-locking-with-postgres-advisory-locks)

**Stack & deployment**
- [Drizzle ORM — Views](https://orm.drizzle.team/docs/views)
- [Neon Connection Pooling](https://neon.com/docs/connect/connection-pooling)
- [Render Postgres Free Tier (30-day expiry caveat)](https://kuberns.com/blogs/render-postgres-pricing-setup-limits/)
- [Platforms with a Real Free Tier for Developers 2026 — Render](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026)
- [NestJS vs Fastify vs Hono 2026](https://encore.dev/articles/nestjs-vs-fastify-vs-hono)
- [Pino Logger Guide — SigNoz](https://signoz.io/guides/pino-logger/)

**Libraries used:** `fastify`, `pg`, `drizzle-orm`, `zod`, `pino`, `dotenv`, `tsx`, `vitest`, `pg-boss`, `cockatiel`, `got`, `@hubspot/api-client`, `googleapis`, `@notionhq/client` (versions in `package.json`).

---

For AI tool usage on this project, see [`AI_USAGE.md`](AI_USAGE.md).
