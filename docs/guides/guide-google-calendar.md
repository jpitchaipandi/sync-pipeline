# Google Calendar Setup

Google Calendar is the **event** source — and the source where the stale-cursor recovery design actually fires in practice. HubSpot's timestamp cursor doesn't expire; Google's `syncToken` does (HTTP 410 GONE), and the orchestrator catches it, flips `needs_full_backfill`, and recovers via a full sync.

## What this enables

| Endpoint | Behavior |
|---|---|
| `POST /sync/google-calendar` | Incremental via `events.list` with stored `syncToken` |
| `POST /sync/google-calendar?mode=full` | Full sync without syncToken (captures a fresh one on completion) |
| `POST /webhooks/google-calendar` | Receives push notifications (payload-less; just triggers an incremental sync) |

## Setup

The Google OAuth dance is the most involved of the three sources. ~10 minutes.

### 1. Enable the Calendar API
- Go to https://console.cloud.google.com
- Create a project (or reuse one). Name doesn't matter — e.g. `sync-pipeline-dev`
- **APIs & Services → Library** → search "Google Calendar API" → **Enable**

### 2. Configure the OAuth consent screen
- **APIs & Services → OAuth consent screen**
  - User Type: **External**
  - App name, support email, developer contact: fill in
  - Scopes: skip — we'll request the scope dynamically via Playground
  - **Test users:** add your own Gmail address — this is what lets you authorize without app verification
- Save

### 3. Create OAuth 2.0 credentials
- **APIs & Services → Credentials → + Create Credentials → OAuth client ID**
  - Application type: **Web application**
  - Name: `sync-pipeline`
  - Authorized redirect URIs: add **exactly** `https://developers.google.com/oauthplayground`
- Create → copy the **Client ID** and **Client secret**

### 4. Get a refresh token via OAuth Playground
- Open https://developers.google.com/oauthplayground
- Click the **gear icon** (top right) → ✅ **Use your own OAuth credentials** → paste your Client ID + secret → Close
- Left panel: scroll to **Calendar API v3** → check `https://www.googleapis.com/auth/calendar.readonly` → click **Authorize APIs**
- Sign in with your Gmail → grant access
  - You'll see "unverified app" since it's in test mode — click Advanced → "Go to … (unsafe)". It's your own app.
- Back on Playground: click **Exchange authorization code for tokens**
- Copy the **refresh_token** (long string starting with `1//`)

### 5. Seed sample data
In your personal Google Calendar (calendar.google.com), create 3-5 events. Mix in:
- A timed event
- An all-day event
- Optionally a recurring series
- Optionally one cancelled event (right-click → delete) — exercises the cancellation handling

### 6. Paste credentials

**Local `.env.local`:**
```bash
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=1//...
GOOGLE_CALENDAR_ID=primary  # or your specific calendar's email
```

**Render dashboard** → Environment → add all four.

### 7. Verify
```bash
URL='https://sync-pipeline-api.onrender.com'
TOKEN='<your API_SECRET>'

curl -X POST "$URL/sync/google-calendar" -H "Authorization: Bearer $TOKEN" | jq

# May take a while if your calendar has years of history.
# Poll the run status:
until [ "$(curl -s "$URL/sync/runs?source=google-calendar&limit=1" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.data.runs[0].status')" != "running" ]; do sleep 5; done

curl "$URL/sync/runs?source=google-calendar&limit=1" -H "Authorization: Bearer $TOKEN" \
  | jq '.data.runs[0] | {status, records_seen, records_upserted, cursor_after: (.cursor_after[0:30]+"...")}'
```

### 8. Verify stale-cursor recovery (the headline demo)
This is the design's proof point — manually corrupt the cursor, watch the system recover:

```bash
# In Neon SQL editor, run:
UPDATE sync_state SET cursor='ThisTokenIsDefinitelyInvalid' WHERE source='google-calendar';

# Then trigger incremental — should fail with CursorExpiredError:
curl -X POST "$URL/sync/google-calendar" -H "Authorization: Bearer $TOKEN"
sleep 8
curl "$URL/sync/runs?source=google-calendar&limit=1" -H "Authorization: Bearer $TOKEN" \
  | jq '.data.runs[0] | {status, error_summary}'
# → status: failed, error: "Cursor expired"

# And sync_state shows the flag:
curl "$URL/sync/status" -H "Authorization: Bearer $TOKEN" \
  | jq '.data.states[] | select(.source == "google-calendar") | {needsFullBackfill, cursor}'
# → needsFullBackfill: true, cursor: null

# Recover via full mode:
curl -X POST "$URL/sync/google-calendar?mode=full" -H "Authorization: Bearer $TOKEN"
sleep 90  # full sync re-fetches everything
curl "$URL/sync/runs?source=google-calendar&limit=1" -H "Authorization: Bearer $TOKEN" \
  | jq '.data.runs[0] | {mode, status, records_seen, records_upserted, records_skipped}'
# → mode: full, status: success, records_skipped: <all of them>
#   (skipped because payload hashes match — idempotent recovery)
```

## Free-tier facts

| Limit | Value |
|---|---|
| Calendar API quota | 1,000,000 queries/day per project |
| Refresh token | Long-lived (months/years) unless explicitly revoked |
| Push channels | Max 7-day TTL; must be renewed |
| Pricing | Free |

## syncToken quirks

### First incremental returns everything again
Empirically: full sync (no syncToken) returns N records + `syncToken_v1`. Next incremental call with `syncToken_v1` returns the same N records + `syncToken_v2`. Third call with `syncToken_v2` returns 0 records (correct steady state).

Idempotency at the record level (`WHERE payload_hash != EXCLUDED.payload_hash`) makes the second sync's re-fetch a no-op write — annoying but not incorrect.

### Token expiry
After ~1-2 weeks idle, or on certain ACL changes, the syncToken expires → HTTP 410 GONE. Our `client.ts` catches this and throws `CursorExpiredError`. The orchestrator handles it by setting `needs_full_backfill=true` and clearing the cursor; the next `mode=full` sync re-establishes state.

## Push channels (optional, not wired into render.yaml)

To exercise live push notifications:

```js
// In any one-shot script (not yet shipped):
calendar.events.watch({
  calendarId: 'primary',
  requestBody: {
    id: crypto.randomUUID(),
    type: 'web_hook',
    address: 'https://sync-pipeline-api.onrender.com/webhooks/google-calendar',
    token: '<your-GOOGLE_WEBHOOK_TOKEN>',  // matches env var
    expiration: String(Date.now() + 7 * 24 * 60 * 60 * 1000),  // 7 days max
  },
});
```

The push body is empty — Google just signals "something changed in this calendar." Our handler verifies `X-Goog-Channel-Token`, dedups by `(resourceId, messageNumber)`, and enqueues an incremental sync. The actual data delta arrives via the stored syncToken.

Channels expire after 7 days — production needs a renewal cron. Out of scope for the portfolio submission.
