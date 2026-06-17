# Sync Pipeline

Multi-source sync pipeline: **HubSpot CRM**, **Google Calendar**, and **Notion** → normalized Postgres.

Built as Problem 1 of the full-stack backend assignment. See `../docs/plans/plan-sync-pipeline.md` for the full implementation plan.

## Status

**Phase 1: Foundation & Deploy Skeleton** — in progress.

## Local Setup

### 1. Prerequisites
- Node.js 20.x
- A Neon Postgres project (https://neon.tech, free tier)

### 2. Configure
```bash
cp .env.example .env.local
# Paste your Neon DATABASE_URL (port 6543 pooler) and DATABASE_URL_DIRECT (port 5432)
```

### 3. Install + migrate + run
```bash
npm install
npm run migrate
npm run dev
```

### 4. Verify
```bash
curl http://localhost:3000/health
# Expected: { "success": true, "data": { "status": "ok", "db": "ok", "uptime": ... } }
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Start in watch mode via `tsx` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm run migrate` | Apply pending SQL migrations |
| `npm test` | Run Vitest unit + integration tests |
| `npm run typecheck` | TypeScript only — no emit |

## Architecture

See `../docs/plans/plan-sync-pipeline.md` for full architecture, data model, and phasing.

Key decisions:
- **Framework:** Fastify (smaller cold-start footprint than NestJS on Render free tier)
- **DB:** Neon Postgres (no 30-day deletion of free-tier data like Render Postgres)
- **ORM:** Drizzle (`pg` pool for raw queries when needed)
- **Idempotency:** Natural key (`source`, `source_record_id`) + content hash skip-if-unchanged
- **Stale cursor recovery:** Per-source `sync_state` row with `needs_full_backfill` flag
- **Failure isolation:** Per-source try/catch in orchestrator; one source's failure never wedges others

## Deployment

Deployed on Render free tier (web service + cron jobs added in Phase 6). The `render.yaml` Blueprint in this directory is the source of truth for the Render configuration.

## Sources & References

(Populated as implementation proceeds — see `../docs/plans/plan-sync-pipeline.md` § Best Practices & Research for the current list.)

## AI Usage Disclosure

This project was built using Claude (Anthropic) for planning and implementation assistance. The full conversation will be linked here on submission.
