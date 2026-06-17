import { z } from 'zod';
import { PayloadValidationError } from '../../core/errors.js';
import type { NormalizedRecord } from '../types.js';

/**
 * Minimal Notion Page schema — Notion's actual response has many more
 * fields but we only need a stable subset for normalization. Property
 * values are heterogeneous (over a dozen types) so the schema accepts
 * `unknown` for property values and stores them verbatim in payload.
 */
const NotionPageSchema = z.object({
  object: z.literal('page').optional(),
  id: z.string().min(1),
  created_time: z.string().optional(),
  last_edited_time: z.string(),
  archived: z.boolean().optional(),
  in_trash: z.boolean().optional(),
  url: z.string().optional(),
  parent: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()),
});

export type NotionPage = z.infer<typeof NotionPageSchema>;

/**
 * Extract the page's title — there is exactly one property of type 'title'
 * per database. Walking the properties looks ugly but is the documented
 * way to find it; Notion doesn't surface the title at the page root.
 */
function extractTitle(properties: Record<string, unknown>): string | null {
  for (const value of Object.values(properties)) {
    if (typeof value !== 'object' || value === null) continue;
    const prop = value as { type?: string; title?: Array<{ plain_text?: string }> };
    if (prop.type === 'title' && Array.isArray(prop.title)) {
      return prop.title.map((t) => t.plain_text ?? '').join('');
    }
  }
  return null;
}

/**
 * Map a Notion Page object to a NormalizedRecord.
 *
 * - entityType: 'page' — Notion calls them pages; "database row" is just
 *   a page with a parent of type database.
 * - sourceUpdatedAt: parsed from `last_edited_time`
 * - archived / in_trash pages are still mapped; downstream consumers can
 *   detect via payload fields if they want soft-delete semantics
 */
export function mapNotionPage(raw: unknown): NormalizedRecord {
  const parsed = NotionPageSchema.safeParse(raw);
  if (!parsed.success) {
    const id = (raw as { id?: unknown })?.id;
    throw new PayloadValidationError(
      'notion',
      typeof id === 'string' ? id : 'unknown',
      parsed.error.issues,
    );
  }

  const page = parsed.data;
  const title = extractTitle(page.properties);

  return {
    source: 'notion',
    sourceRecordId: page.id,
    entityType: 'page',
    payload: {
      id: page.id,
      title,
      url: page.url ?? null,
      created_time: page.created_time ?? null,
      last_edited_time: page.last_edited_time,
      archived: page.archived ?? false,
      in_trash: page.in_trash ?? false,
      properties: page.properties,
    },
    sourceUpdatedAt: new Date(page.last_edited_time),
  };
}
