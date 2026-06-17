import type { FastifyInstance } from 'fastify';
import { ping } from '../../db/client.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    const dbOk = await ping();
    const status = dbOk ? 'ok' : 'error';
    const httpStatus = dbOk ? 200 : 503;

    return reply.code(httpStatus).send({
      success: dbOk,
      data: {
        status,
        db: dbOk ? 'ok' : 'error',
        uptime: process.uptime(),
      },
    });
  });
}
