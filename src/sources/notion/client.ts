import { Client } from '@notionhq/client';
import { env } from '../../config/env.js';
import { SourceApiError } from '../../core/errors.js';
import { createSourcePolicy } from '../../core/resilience.js';

const PAGE_SIZE = 100;

let cachedClient: Client | null = null;
function getClient(): Client {
  if (cachedClient) return cachedClient;
  if (!env.NOTION_API_KEY) {
    throw new Error('NOTION_API_KEY is not configured');
  }
  cachedClient = new Client({ auth: env.NOTION_API_KEY });
  return cachedClient;
}

function getDatabaseId(): string {
  if (!env.NOTION_DATABASE_ID) {
    throw new Error('NOTION_DATABASE_ID is not configured');
  }
  return env.NOTION_DATABASE_ID;
}

/**
 * Notion v5 split database queries onto data sources. Legacy databases
 * (created pre-multi-source) get a default data source with the same id
 * as the database, but newly-created databases may have a different id.
 *
 * We look up the data source id once on first query and cache it. If the
 * lookup fails (integration not shared with the database, or invalid id)
 * the error surfaces directly so the operator sees the real problem.
 */
let cachedDataSourceId: string | null = null;
async function resolveDataSourceId(): Promise<string> {
  if (cachedDataSourceId) return cachedDataSourceId;

  const databaseId = getDatabaseId();
  const client = getClient();
  try {
    const db = await client.databases.retrieve({ database_id: databaseId });
    const dataSources = (db as { data_sources?: Array<{ id: string }> }).data_sources;
    if (dataSources && dataSources.length > 0 && dataSources[0]) {
      cachedDataSourceId = dataSources[0].id;
    } else {
      cachedDataSourceId = databaseId; // legacy database: same id
    }
    return cachedDataSourceId;
  } catch (err) {
    throw toSourceApiError(err);
  }
}

const policy = createSourcePolicy('notion');

interface ApiErrorShape {
  status?: number;
  code?: string;
  message?: string;
}

function toSourceApiError(err: unknown): SourceApiError {
  const e = err as ApiErrorShape;
  const status = e?.status ?? 0;
  const message = e?.message ?? 'unknown Notion error';
  return new SourceApiError('notion', status, message, { code: e?.code });
}

/**
 * Iterate pages in the configured database. If `sinceIso` is null we
 * fetch every page (full sync). Otherwise we filter by
 * `last_edited_time on_or_after sinceIso` (incremental).
 *
 * Sorted ascending by `last_edited_time` so the caller can track the
 * high-water mark as it goes — without needing to buffer the whole
 * result set.
 *
 * No CursorExpiredError path: Notion timestamps don't expire. If the
 * `sinceIso` is malformed Notion returns 400, which surfaces as
 * SourceApiError.
 */
export async function* queryDatabase(
  sinceIso: string | null,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  const client = getClient();
  const dataSourceId = await resolveDataSourceId();

  let startCursor: string | undefined;

  while (true) {
    if (signal?.aborted) return;

    const response = await policy.execute(async () => {
      try {
        return await client.dataSources.query({
          data_source_id: dataSourceId,
          page_size: PAGE_SIZE,
          ...(startCursor ? { start_cursor: startCursor } : {}),
          ...(sinceIso
            ? {
                filter: {
                  timestamp: 'last_edited_time',
                  last_edited_time: { on_or_after: sinceIso },
                },
              }
            : {}),
          sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
        });
      } catch (err) {
        throw toSourceApiError(err);
      }
    });

    for (const result of response.results) {
      yield result;
    }

    if (!response.has_more || !response.next_cursor) return;
    startCursor = response.next_cursor;
  }
}
