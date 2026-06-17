# Render Setup

Render hosts the Fastify web service. Deploy is driven by `render.yaml` (Infrastructure-as-Code Blueprint).

## What runs where

| Component | Hosting |
|---|---|
| Web service (`sync-pipeline-api`) | Render Web Service, Free, Node |
| Postgres | Neon (external — see [guide-neon.md](guide-neon.md)) |
| Scheduled cron | **Deferred** — Render Cron Jobs require a paid plan |

## Setup

### 1. Push the repo to GitHub
The project must live in a Git repo Render can read. Example:
```bash
gh repo create sync-pipeline --public --source=. --remote=origin --push
```

### 2. Connect Render to the repo
- Sign up at https://render.com (GitHub login)
- **New +** → **Blueprint**
- Connect your GitHub account if not already done
- Select the `sync-pipeline` repo
- Render reads `render.yaml` and shows it'll create one service: `sync-pipeline-api`
- Click **Apply / Create Resources**

### 3. Set secret env vars
Render generates `API_SECRET` automatically (the Blueprint declares `generateValue: true`). You need to paste in:

| Variable | Value | Source |
|---|---|---|
| `DATABASE_URL` | Pooled Neon URL (port 6543) | [Neon dashboard](guide-neon.md) |
| `DATABASE_URL_DIRECT` | Direct Neon URL (port 5432) | [Neon dashboard](guide-neon.md) |
| `HUBSPOT_ACCESS_TOKEN` | Optional | [HubSpot guide](guide-hubspot.md) |
| `HUBSPOT_CLIENT_SECRET` | Optional | [HubSpot guide](guide-hubspot.md) |
| `GOOGLE_CLIENT_ID` | Optional | [GCal guide](guide-google-calendar.md) |
| `GOOGLE_CLIENT_SECRET` | Optional | [GCal guide](guide-google-calendar.md) |
| `GOOGLE_REFRESH_TOKEN` | Optional | [GCal guide](guide-google-calendar.md) |
| `NOTION_API_KEY` | Optional | [Notion guide](guide-notion.md) |
| `NOTION_DATABASE_ID` | Optional | [Notion guide](guide-notion.md) |

All credentials are optional individually — the service starts with whatever's present and logs a warning for each missing source.

Service URL after deploy: `https://sync-pipeline-api.onrender.com`

### 4. Verify
```bash
curl https://sync-pipeline-api.onrender.com/health
# → {"success":true,"data":{"status":"ok","db":"ok","uptime":...}}
```

Note your `API_SECRET` (Render dashboard → Environment → click the eye icon) — you'll use it for the authenticated endpoints.

## Free-tier facts

| Limit | Value |
|---|---|
| Instance hours | 750/month |
| Spin-down | after 15 min idle |
| Cold start | ~30–60 s |
| Cron jobs | **Not on free tier** (paid only) |
| Background workers | **Not on free tier** (paid only) |
| Postgres | Available but 30-day expiry — we use Neon instead |

## Gotchas we hit

### 1. `tsx: not found` during build
Render sets `NODE_ENV=production`, which makes `npm ci` skip `devDependencies`. `tsx` lived there. Fixed by compiling migrate.ts to JS and running it via `node dist/db/migrate.js` (`migrate:prod` script). See `package.json`:

```json
"build": "tsc -p tsconfig.build.json && mkdir -p dist/db/migrations && cp src/db/migrations/*.sql dist/db/migrations/",
"migrate:prod": "node dist/db/migrate.js"
```

### 2. `render.yaml` changes don't auto-apply
Blueprints apply at creation time. Subsequent commits to `render.yaml` don't auto-update existing services. Two ways forward:
- **Re-sync the Blueprint:** Dashboard → Blueprints → your Blueprint → **Sync**
- **Edit manually:** Dashboard → Service → Settings → edit Build Command / env vars directly

### 3. Repo access warning
If you see `It looks like we don't have access to your repo, but we'll try to clone it anyway`, Render is cloning anonymously via public access. Builds work; auto-deploy webhooks may lag. Fix: Settings → Repository → reconnect with proper GitHub OAuth.

### 4. Cron is paid
Render's free tier doesn't host Cron Jobs (error: `"free not a valid plan for service type cron"`). Two options:
- **Production:** upgrade to a paid plan (~$1/month per cron)
- **Free alternative:** [cron-job.org](guide-cron-job.md) (external)

The current deployment runs no automatic schedule. Trigger syncs manually via `POST /sync/all` or use cron-job.org.

## Spin-down behavior

After 15 minutes with no requests, the service stops. First request after that takes ~30 s to cold-start. For demos, hit `/health` once a few seconds before showing anything.
