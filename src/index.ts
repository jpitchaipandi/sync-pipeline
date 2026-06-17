import Fastify from 'fastify';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { pool, closePool } from './db/client.js';
import { healthRoutes } from './api/routes/health.js';

async function cleanupStaleRuns(): Promise<void> {
  try {
    await pool.query('SELECT cleanup_stale_runs()');
    logger.info('Stale runs cleaned up');
  } catch (err) {
    // Function may not exist yet on first boot if migrations have not run.
    logger.warn({ err }, 'cleanup_stale_runs() not available — skipping');
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

  app.setErrorHandler((err, req, reply) => {
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

  return app;
}

async function start(): Promise<void> {
  await cleanupStaleRuns();

  const app = await buildApp();

  try {
    const address = await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info({ address, env: env.NODE_ENV }, 'sync-pipeline started');
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    await app.close();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void start();
