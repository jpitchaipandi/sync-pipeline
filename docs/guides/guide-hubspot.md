# HubSpot Setup

HubSpot is the CRM source — contacts, companies, deals.

## What this enables

| Endpoint | Behavior |
|---|---|
| `POST /sync/hubspot` | Triggers incremental sync via CRM Search API (`hs_lastmodifieddate GTE cursor`) |
| `POST /sync/hubspot?mode=full` | Triggers full backfill via basic list API (bypasses the 10k Search cap) |
| `POST /webhooks/hubspot` | Receives webhook events; HMAC-SHA256 v3 signature verification + dedup via `webhook_events.event_id` |

## Setup

### 1. Create a developer test account
- Go to https://developers.hubspot.com/get-started
- Sign up (free) → create a **developer test account**
  - Use a test account, not your real HubSpot org, so seeded data doesn't pollute anything real
- HubSpot will pre-seed the account with one company ("HubSpot") and two sample contacts ("Maria Johnson", "Brian Halligan")

### 2. Create a private app
- Inside your test account: **Apps** → **Private Apps** → **Create Private App**
- Name: `sync-pipeline-dev` (anything)
- **Scopes** tab — enable read on the objects you want to sync:
  - `crm.objects.contacts.read`
  - `crm.objects.companies.read`
  - `crm.objects.deals.read`
- Click **Create app**
- Copy two values:
  - **Access token** (looks like `pat-na1-...` or `pat-eu1-...`)
  - **Client secret** (under the "Auth" tab — needed for webhook signature verification)

### 3. Seed sample data
The pre-seeded company + contacts already give you 3 records. For more variety, manually add a few via the HubSpot UI:
- 2-3 more contacts
- 1-2 deals (under Sales → Deals)

### 4. Paste credentials

**Local `.env.local`:**
```bash
HUBSPOT_ACCESS_TOKEN=pat-na1-...
HUBSPOT_CLIENT_SECRET=...
```

**Render dashboard** → Environment → add both vars to `sync-pipeline-api`.

### 5. Verify
```bash
URL='https://sync-pipeline-api.onrender.com'
TOKEN='<your API_SECRET>'

curl -X POST "$URL/sync/hubspot" -H "Authorization: Bearer $TOKEN" | jq

sleep 15  # wait for pg-boss to pick up the job + HubSpot fetch

curl "$URL/sync/runs?source=hubspot&limit=1" -H "Authorization: Bearer $TOKEN" \
  | jq '.data.runs[0]'
```

Expected on first run: `status: success, records_seen: N, records_upserted: N, records_skipped: 0`.

On re-trigger: `records_upserted: 0, records_skipped: N` (idempotent — skip-if-unchanged hash guard).

## Free-tier facts

| Limit | Value |
|---|---|
| Developer accounts | Unlimited free |
| API rate limit (free) | 100 req / 10 s, 250k/day |
| Search API rate limit | ~4 req/s shared across all object types |
| Search API record cap | 10,000 results per query (use object-ID walk via basicApi for full backfills) |
| Webhook signature | v3 (HMAC-SHA256), recommended |

## Webhook setup (optional)

To exercise the webhook path on the live deployment:

1. Inside your private app → **Webhooks** tab → **Create subscription**
2. Target URL: `https://sync-pipeline-api.onrender.com/webhooks/hubspot`
3. Event: subscribe to `contact.creation`, `contact.propertyChange`, or whatever subset you want
4. Save

Then edit a contact in HubSpot UI — HubSpot fires a webhook → our handler verifies the HMAC, dedups by `eventId`, and stores it in `webhook_events`.

**Webhook v3 signature format** (so you understand what we're verifying):
```
HMAC-SHA256({HTTP_METHOD}{REQUEST_URI}{REQUEST_BODY}{TIMESTAMP}, clientSecret) → base64
```

Plus a 5-minute timestamp drift window for replay protection.

## Gotchas

### Search API has indexing lag
Newly-created records may not appear in Search API results for some time after creation. The first `mode=incremental` sync (cursor=null) might pull fewer records than `mode=full`. This is why we have both paths:
- **Steady-state incremental** — Search API filtered by `hs_lastmodifieddate` (cheap)
- **Initial seed / backfill** — basic list API via object-ID walk (bypasses indexing lag AND the 10k cap)

### `FilterOperatorEnum` import
The HubSpot SDK v13 types filter operators as per-object-type enums, not string unions. Importing the wrong one causes `Type 'string' is not assignable to type 'never'`. See `src/sources/hubspot/client.ts`:
```ts
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts/index.js';
// ... operator: FilterOperatorEnum.Gte
```

The runtime value is just the string `"GTE"`; the enum import is purely for TypeScript.

### Rate limit headers absent on Search API
The Search API doesn't return rate-limit headers. Handle 429s reactively via the Cockatiel retry policy (already wired in `createSourcePolicy('hubspot')`).
