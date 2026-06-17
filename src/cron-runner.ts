/**
 * Render Cron Job entry point. Standalone — does NOT import the web
 * service's DB client, queue, or orchestrator. Hits the web service's
 * public HTTP endpoint via the bearer token.
 *
 * Two effects per invocation:
 *   1. Wakes the web service from spin-down (free tier sleeps after
 *      15 minutes idle; cron at every-10-min keeps it warm).
 *   2. Triggers `POST /sync/all` so each source runs an incremental
 *      sync via the pg-boss worker.
 */
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: ['.env.local', '.env'] });

const url = process.env.WEB_SERVICE_URL;
const secret = process.env.API_SECRET;

if (!url) {
  console.error('WEB_SERVICE_URL not set');
  process.exit(1);
}
if (!secret) {
  console.error('API_SECRET not set');
  process.exit(1);
}

async function run(): Promise<void> {
  const started = Date.now();

  // Keep-alive ping (also wakes the service from spin-down).
  const healthRes = await fetch(`${url}/health`);
  if (!healthRes.ok) {
    console.error(JSON.stringify({ event: 'health_check_failed', status: healthRes.status }));
    process.exit(1);
  }

  // Trigger all sources via the API.
  const syncRes = await fetch(`${url}/sync/all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });

  const body = await syncRes.text();
  const durationMs = Date.now() - started;

  console.log(
    JSON.stringify({
      event: 'cron_run_complete',
      status: syncRes.status,
      duration_ms: durationMs,
      response: safeJson(body),
    }),
  );

  if (!syncRes.ok) process.exit(1);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}

run().catch((err: unknown) => {
  console.error(
    JSON.stringify({
      event: 'cron_run_error',
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
