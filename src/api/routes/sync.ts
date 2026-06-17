import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/client.js';
import { getAllSyncStates } from '../../core/cursor-store.js';
import { enqueueSync } from '../../jobs/sync-job.js';
import { authPlugin } from '../plugins/auth.js';
import type { SourceId, SyncMode } from '../../sources/types.js';

const SOURCES: SourceId[] = ['hubspot', 'google-calendar', 'notion'];

const ParamsSchema = z.object({
  source: z.enum(['hubspot', 'google-calendar', 'notion']),
});

const ModeQuerySchema = z.object({
  mode: z.enum(['incremental', 'full']).default('incremental'),
});

const RunsQuerySchema = z.object({
  source: z.enum(['hubspot', 'google-calendar', 'notion']).optional(),
  status: z.enum(['running', 'success', 'failed', 'partial']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const syncRoutes: FastifyPluginAsync = async (app) => {
  await app.register(authPlugin);

  app.post('/sync/:source', async (req, reply) => {
    const params = ParamsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_SOURCE', message: 'Unknown source' },
      });
    }

    const query = ModeQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_MODE', message: 'mode must be incremental or full' },
      });
    }

    const jobId = await enqueueSync({
      source: params.data.source,
      mode: query.data.mode,
      triggeredBy: 'api',
    });

    if (!jobId) {
      return reply.code(409).send({
        success: false,
        error: {
          code: 'SYNC_ALREADY_RUNNING',
          message: `Sync for ${params.data.source}:${query.data.mode} is already queued or running`,
        },
      });
    }

    return reply.code(202).send({
      success: true,
      data: { jobId, source: params.data.source, mode: query.data.mode },
    });
  });

  app.post('/sync/all', async (req, reply) => {
    const query = ModeQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_MODE', message: 'mode must be incremental or full' },
      });
    }
    const mode: SyncMode = query.data.mode;

    const results = await Promise.all(
      SOURCES.map(async (source) => {
        const jobId = await enqueueSync({ source, mode, triggeredBy: 'api-all' });
        return { source, mode, jobId, queued: jobId !== null };
      }),
    );

    return reply.code(202).send({ success: true, data: { results } });
  });

  app.get('/sync/status', async (_req, reply) => {
    const states = await getAllSyncStates(pool);
    return reply.send({ success: true, data: { states } });
  });

  app.get('/sync/runs', async (req, reply) => {
    const query = RunsQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({
        success: false,
        error: { code: 'INVALID_QUERY', message: 'Invalid query parameters' },
      });
    }

    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (query.data.source) {
      params.push(query.data.source);
      conditions.push(`source = $${params.length}`);
    }
    if (query.data.status) {
      params.push(query.data.status);
      conditions.push(`status = $${params.length}`);
    }
    params.push(query.data.limit);
    const limitPlaceholder = `$${params.length}`;

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await pool.query(
      `SELECT run_id, source, mode, triggered_by, status,
              started_at, ended_at,
              records_seen, records_upserted, records_skipped, records_failed,
              cursor_before, cursor_after, error_summary
       FROM sync_runs
       ${whereClause}
       ORDER BY started_at DESC
       LIMIT ${limitPlaceholder}`,
      params,
    );

    return reply.send({ success: true, data: { runs: result.rows } });
  });
};
