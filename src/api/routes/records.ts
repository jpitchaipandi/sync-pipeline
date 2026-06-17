import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/client.js';
import { authPlugin } from '../plugins/auth.js';

const RecordsQuerySchema = z.object({
  source: z.enum(['hubspot', 'google-calendar', 'notion']).optional(),
  entity_type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  // Keyset cursor: pass back the `next_cursor` from the previous response.
  // Encodes (synced_at, id) so pagination is stable even as new rows land.
  cursor: z.string().optional(),
});

interface CursorPayload {
  synced_at: string;
  id: string;
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as CursorPayload;
    if (typeof parsed.synced_at !== 'string' || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export const recordsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(authPlugin);

  app.get('/records', async (req, reply) => {
    const parsed = RecordsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_QUERY', message: parsed.error.issues[0]?.message ?? 'bad query' },
      });
    }
    const { source, entity_type, limit, cursor } = parsed.data;

    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (source) {
      params.push(source);
      conditions.push(`source = $${params.length}`);
    }
    if (entity_type) {
      params.push(entity_type);
      conditions.push(`entity_type = $${params.length}`);
    }
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        return reply.code(400).send({
          success: false,
          error: { code: 'INVALID_CURSOR', message: 'cursor is malformed' },
        });
      }
      params.push(decoded.synced_at);
      params.push(decoded.id);
      const a = params.length - 1;
      const b = params.length;
      // Keyset: (synced_at, id) < (cursor.synced_at, cursor.id)
      conditions.push(`(synced_at, id) < ($${a}::timestamptz, $${b}::uuid)`);
    }
    params.push(limit + 1); // fetch one extra to know if there's more
    const limitPlaceholder = `$${params.length}`;

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT id, source, source_record_id, entity_type, payload,
              source_updated_at, synced_at, created_at, is_deleted
       FROM records
       ${whereClause}
       ORDER BY synced_at DESC, id DESC
       LIMIT ${limitPlaceholder}`,
      params,
    );

    const hasMore = result.rows.length > limit;
    const items = hasMore ? result.rows.slice(0, limit) : result.rows;
    const last = items[items.length - 1] as { synced_at: Date; id: string } | undefined;

    const next_cursor =
      hasMore && last
        ? encodeCursor({ synced_at: last.synced_at.toISOString(), id: last.id })
        : null;

    return reply.send({
      success: true,
      data: { records: items, next_cursor },
    });
  });
};
