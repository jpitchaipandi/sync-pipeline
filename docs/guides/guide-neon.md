# Neon Postgres Setup

The pipeline uses Neon as its primary datastore — schema migrations create `records`, `sync_state`, `sync_runs`, `webhook_events`, and `schema_migrations`. pg-boss creates an additional `pgboss` schema for the job queue on first start.

## Why Neon (and not Render Postgres)

Render's free Postgres tier **deletes the database after 30 days** — disqualifying for a portfolio project. Neon's free tier has no expiry; compute scales to zero after 5 minutes idle and wakes back up in ~1 second on the next query.

## Setup

### 1. Create the project
- Sign up at https://neon.tech (GitHub login works)
- **+ New Project**
  - Name: `sync-pipeline` (anything)
  - Postgres version: latest stable
  - Region: pick whatever's closest to your Render region (Oregon for us)
- Click **Create project**

### 2. Copy two connection strings
The Neon dashboard shows the connection details for your default database. You need two URLs:

| Variable | Which URL to use | Used by |
|---|---|---|
| `DATABASE_URL` | **Pooled** connection (port `6543`, hostname has `-pooler` in it) | Runtime queries, pg-boss |
| `DATABASE_URL_DIRECT` | **Direct** connection (port `5432`, no `-pooler`) | Migrations only (DDL via pgbouncer is unreliable) |

In the dashboard, the connection-string panel has a "Pooled connection" toggle. Copy each URL with that toggle in the appropriate position.

Both should look like:
```
postgresql://USER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?sslmode=require
```

### 3. Paste into env vars

**Local `.env.local`:**
```bash
DATABASE_URL=postgresql://...-pooler.../neondb?sslmode=require
DATABASE_URL_DIRECT=postgresql://.../neondb?sslmode=require
```

**Render dashboard** → Environment → add both vars to `sync-pipeline-api`.

### 4. Apply migrations
Migrations are applied automatically as part of the Render build (`npm run migrate:prod` in `buildCommand`). For local setup:

```bash
npm install
npm run migrate
```

You should see `Migration applied filename=001_initial_schema.sql`, etc. Re-runs are no-ops thanks to `schema_migrations` tracking.

### 5. Verify
```bash
curl http://localhost:3000/health
# → {"success":true,"data":{"status":"ok","db":"ok","uptime":...}}
```

## Free-tier facts (as of 2025)

| Limit | Value |
|---|---|
| Storage | 0.5 GB |
| Compute | scales to zero after 5 min idle |
| Cold start | ~1 second |
| Expiry | None |
| Connection pooling | Built-in PgBouncer |

## Gotchas

- **Use the pooled URL for `DATABASE_URL`.** The direct URL (port 5432) caps connection count low; the pgbouncer URL (port 6543) multiplexes.
- **Don't run migrations via the pooler.** pgbouncer's transaction-pooling mode doesn't play well with DDL. The runner detects `DATABASE_URL_DIRECT` and uses it instead.
- **Scale-to-zero cold start.** First query after idle takes ~1s. The `pg.Pool` has `connectionTimeoutMillis: 5000` to absorb this.
- **pgboss schema.** pg-boss creates its own tables (`pgboss.job`, `pgboss.schedule`, etc.) automatically. Don't version-control migrations for them.
