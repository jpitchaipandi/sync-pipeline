# Notion Setup

Notion is the **document/page** source. The cleanest of the three sources — no cursor expiry, no record cap, no webhook complications. Just a `last_edited_time` timestamp filter for incremental.

## What this enables

| Endpoint | Behavior |
|---|---|
| `POST /sync/notion` | Incremental via `dataSources.query` with `last_edited_time on_or_after` filter |
| `POST /sync/notion?mode=full` | Full sync without timestamp filter |

No webhook endpoint — Notion's webhooks aren't usable with internal integrations the way we set them up.

## Setup

5 minutes if you have a Notion workspace.

### 1. Create the connection
Notion renamed "Integrations" → "Connections" in 2024. They're the same thing.

- Go to https://www.notion.so/my-integrations (or `notion.so/profile/integrations` — both work)
- Click **+ New connection** (used to be "+ New integration")
- Name: `sync-pipeline`
- Associated workspace: pick yours
- Type: **Internal** (sometimes labeled "Internal connection")
- Capabilities: ✅ **Read content** is enough — uncheck write/comment access (we don't need them)
- Click **Save**
- Click **Show** next to "Internal Integration Token" → copy it
  - New format: `ntn_...`
  - Legacy format: `secret_...` (both still work)

### 2. Pick or create a database
- In Notion, create a new page → add a **Database - Full page** (or use any existing database)
- Add 5-10 rows with whatever content — tasks, reading list, anything
- Doesn't matter what; the mapper preserves all properties verbatim

### 3. Share the database with the connection
**Easy to forget.** Without this step, the API can't see the database (you'll get `Could not find database with ID: ...`).

- Open the database in Notion
- Click the **`...`** menu (top-right of the page)
- **+ Add connections** → search `sync-pipeline` → select → confirm

### 4. Copy the database ID
- Look at the database URL: `https://www.notion.so/<workspace>/<DATABASE_ID>?v=...`
- The 32-char hex string (with optional dashes) is the database ID
- Example: `f1a8c2e0-1234-5678-9abc-def012345678` or unhyphenated `f1a8c2e012345678abcdef012345678`

### 5. Paste credentials

**Local `.env.local`:**
```bash
NOTION_API_KEY=ntn_...
NOTION_DATABASE_ID=f1a8c2e0...
```

**Render dashboard** → Environment → add both.

### 6. Verify
```bash
URL='https://sync-pipeline-api.onrender.com'
TOKEN='<your API_SECRET>'

curl -X POST "$URL/sync/notion" -H "Authorization: Bearer $TOKEN" | jq

sleep 5
curl "$URL/sync/runs?source=notion&limit=1" -H "Authorization: Bearer $TOKEN" \
  | jq '.data.runs[0]'

# See the synced pages with titles:
curl "$URL/records?source=notion&limit=10" -H "Authorization: Bearer $TOKEN" \
  | jq '.data.records[] | {entity_type, title: .payload.title}'
```

## Free-tier facts

| Limit | Value |
|---|---|
| API rate limit | 3 requests/second per integration |
| Database/page size | Generous; not relevant for sync use case |
| Pricing | Free for personal workspaces; Notion Plus or higher for shared workspaces |
| Webhooks | Public API exists but not usable with internal connections |

## Gotchas

### `databases.query` is gone in SDK v5
Notion SDK v5 (2025) split queries onto a new `dataSources.query` method to support multi-data-source databases. Our `src/sources/notion/client.ts` handles both legacy and new databases:

```ts
// Resolve data_source_id once via databases.retrieve, cache it
const db = await client.databases.retrieve({ database_id });
const dataSourceId = db.data_sources?.[0]?.id ?? database_id;
// Then use dataSources.query({ data_source_id: dataSourceId, ... })
```

For legacy single-source databases, `dataSources[0].id === database_id` (Notion preserved backward compat). For new multi-source DBs, the IDs differ.

### Title extraction
Notion doesn't surface a page title at the top level — it's a property of type `'title'` inside the properties object. The mapper walks the properties to find it:

```ts
function extractTitle(properties: Record<string, unknown>): string | null {
  for (const value of Object.values(properties)) {
    if (typeof value === 'object' && value !== null) {
      const prop = value as { type?: string; title?: Array<{ plain_text?: string }> };
      if (prop.type === 'title' && Array.isArray(prop.title)) {
        return prop.title.map(t => t.plain_text ?? '').join('');
      }
    }
  }
  return null;
}
```

### Archived pages
Notion's `databases.query` returns archived (soft-deleted) pages with `archived: true`. The mapper preserves this flag in `payload.archived` so downstream consumers can detect soft deletes. We don't hard-delete from `records`.
