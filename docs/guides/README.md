# Setup Guides

Step-by-step guides for each external system the pipeline depends on. Read these in order if you're setting up the project from scratch.

| Guide | What it enables | Free tier? |
|---|---|---|
| [guide-neon.md](guide-neon.md) | Postgres database (records, sync_state, sync_runs, webhook_events, pg-boss schema) | ✅ no expiry |
| [guide-render.md](guide-render.md) | Hosting the Fastify web service | ✅ web service only (cron is paid) |
| [guide-hubspot.md](guide-hubspot.md) | HubSpot CRM source — contacts, companies, deals | ✅ developer account |
| [guide-google-calendar.md](guide-google-calendar.md) | Google Calendar source — events | ✅ |
| [guide-notion.md](guide-notion.md) | Notion source — database pages | ✅ |
| [guide-cron-job.md](guide-cron-job.md) | External scheduler that pings `/sync/all` (Render free tier doesn't host cron) | ✅ |

## Minimum viable setup

To get a deployed pipeline running, you need:

1. **Neon** (database) — required
2. **Render** (hosting) — required
3. **At least one source** (HubSpot, GCal, or Notion) — required for any data to flow
4. **cron-job.org** — optional; only needed for automatic scheduled syncs on the free tier

Each source is independently disable-able — the service starts up with whatever credentials are present and logs a warning for missing ones (see `src/index.ts`).

## Environment variables produced

Each guide tells you exactly which env vars to set. The full list across all sources lives in [`.env.example`](../../.env.example).
