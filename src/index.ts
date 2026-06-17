import Fastify, { type FastifyError } from 'fastify';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { pool, closePool } from './db/client.js';
import { healthRoutes } from './api/routes/health.js';
import { syncRoutes } from './api/routes/sync.js';
import { webhookRoutes } from './api/routes/webhooks.js';
import { startQueue, stopQueue } from './jobs/queue.js';
import { registerSyncWorker } from './jobs/sync-job.js';
import { registerHubspot } from './sources/hubspot/index.js';
import { registerGoogleCalendar } from './sources/google-calendar/index.js';
import { registerNotion } from './sources/notion/index.js';

async function cleanupStaleRuns(): Promise<void> {
  try {
    await pool.query('SELECT cleanup_stale_runs()');
    logger.info('stale_runs_cleaned');
  } catch (err) {
    // Function may not exist yet on first boot if migrations have not run.
    logger.warn({ err }, 'cleanup_stale_runs_unavailable');
  }
}

async function buildApp() {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    bodyLimit: 1_048_576,
  });

  app.addHook('onRequest', async (req) => {
    logger.debug({ method: req.method, url: req.url }, 'request');
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    logger.error({ err, url: req.url }, 'request_error');
    reply.code(err.statusCode ?? 500).send({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: err.message ?? 'Internal server error',
      },
    });
  });

  await app.register(healthRoutes);
  await app.register(syncRoutes);
  await app.register(webhookRoutes);

  return app;
}

async function start(): Promise<void> {
  await cleanupStaleRuns();

  if (env.HUBSPOT_ACCESS_TOKEN) {
    registerHubspot();
  } else {
    logger.warn('HUBSPOT_ACCESS_TOKEN missing — HubSpot source disabled');
  }

  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
    registerGoogleCalendar();
  } else {
    logger.warn('GOOGLE_* env vars missing — Google Calendar source disabled');
  }

  if (env.NOTION_API_KEY && env.NOTION_DATABASE_ID) {
    registerNotion();
  } else {
    logger.warn('NOTION_* env vars missing — Notion source disabled');
  }

  await startQueue();
  await registerSyncWorker();

  const app = await buildApp();

  try {
    const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info({ address, env: env.NODE_ENV }, 'sync_pipeline_started');
  } catch (err) {
    logger.fatal({ err }, 'failed_to_start_server');
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting_down');
    await app.close();
    await stopQueue();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void start();
