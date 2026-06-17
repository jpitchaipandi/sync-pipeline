import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Fastify plugin (wrapped with fastify-plugin so hooks apply to the parent
 * scope). Register inside a route plugin to require a Bearer token matching
 * env.API_SECRET on every request in that scope.
 *
 * 503 if API_SECRET is not configured (deployment misconfiguration).
 * 401 if header missing, malformed, or token mismatch.
 */
const authPluginImpl: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req, reply) => {
    const expected = env.API_SECRET;
    if (!expected) {
      reply.code(503).send({
        success: false,
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'API_SECRET is not configured on the server',
        },
      });
      return;
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      reply.code(401).send({
        success: false,
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or malformed Authorization header',
        },
      });
      return;
    }

    const token = header.slice(BEARER_PREFIX.length).trim();
    if (token.length !== expected.length) {
      reply.code(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
      });
      return;
    }

    const tokenBuf = Buffer.from(token, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (!timingSafeEqual(tokenBuf, expectedBuf)) {
      reply.code(401).send({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
      });
      return;
    }
  });
};

export const authPlugin = fp(authPluginImpl, { name: 'auth' });
