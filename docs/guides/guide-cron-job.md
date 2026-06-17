# cron-job.org Setup (Free-Tier Scheduler)

Render's free tier doesn't host Cron Jobs. cron-job.org is the cleanest free workaround — it's a managed HTTP scheduler that fires POST requests with custom headers on a configurable schedule.

**Note:** this setup is **optional** for the portfolio submission. The current deployment runs no automatic schedule; syncs are triggered manually via `POST /sync/all`. Wire up cron-job.org if you want incremental syncs to fire automatically (e.g., to keep the Render web service warm + capture changes within a 10-minute window).

## What it does

| Effect | How |
|---|---|
| Keeps Render web service warm | Each HTTP request resets the 15-min spin-down timer |
| Triggers all three sources to sync | `POST /sync/all` enqueues per-source jobs via pg-boss |

The job is just an HTTP call — no infrastructure on our side. The actual sync work happens inside the Render web service via pg-boss workers.

## Setup

### 1. Sign up
- Go to https://cron-job.org
- Click **Sign up** (free, email-only)
- Confirm email

### 2. Create the job
- **+ Create cronjob** (top-right after login)

### 3. Common tab
- **Title:** `sync-pipeline-all`
- **URL:** `https://sync-pipeline-api.onrender.com/sync/all`
- Save

### 4. Advanced tab
- **Request method:** `POST`
- **Custom HTTP headers** — Add one:
  - Header name: `Authorization`
  - Header value: `Bearer <YOUR_API_SECRET>` (the same value Render generated for `sync-pipeline-api`)
- Save

### 5. Schedule tab
- **Type:** Every N minutes
- **Interval:** `10` minutes
- (You can go as low as 1 minute on the free tier, but 10 is a sensible default — anything <15 keeps Render from sleeping)
- Save

### 6. Enable the job
- The toggle at the top of the cronjob detail page should be on by default
- You can hit **Execute now** to fire it once for testing

## Verify

After the first scheduled fire (or after clicking "Execute now"):

```bash
URL='https://sync-pipeline-api.onrender.com'
TOKEN='<your API_SECRET>'

curl "$URL/sync/runs?limit=6" -H "Authorization: Bearer $TOKEN" \
  | jq '.data.runs[] | {source, triggered_by, status, started_at}'
```

You should see three rows with `triggered_by: "api-all"` (the route name used by `/sync/all`).

Inside cron-job.org's dashboard, the job's **History** tab shows the last N invocations with HTTP status codes — handy for debugging.

## Free-tier facts

| Limit | Value |
|---|---|
| Jobs per account | Several dozen |
| Schedule granularity | Down to 1-minute |
| Execution history | Last ~25 runs visible |
| Email alerts on failure | Available |
| Pricing | Free |

## Why not Render Cron, GitHub Actions, or UptimeRobot?

- **Render Cron** — requires a paid plan (~$1/month). Best choice for production; our `render.yaml` documents the setup.
- **GitHub Actions** — works (cron triggers free for public repos) but adds a CI dependency and the cron run is one more place reviewers have to look. Fine if you're already heavily using Actions.
- **UptimeRobot** — free uptime monitor; pings any URL on a schedule. **But:** only supports GET (not POST), so can't trigger `/sync/all`. You'd need to wrap `/sync/all` in a GET endpoint, which is bad REST and re-introduces complexity.

cron-job.org wins on: free, supports POST + custom headers, granular schedule, decent dashboard.

## Production migration path

When moving off the free tier:
1. Upgrade Render to a paid plan
2. Re-sync the Blueprint (or manually create) the cron service per the commented stanza in `render.yaml`
3. Disable the cron-job.org job (or keep it as a redundant fallback)
4. `src/cron-runner.ts` is the script Render Cron will execute — it's already written

No code changes needed.
