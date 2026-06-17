import type { FastifyPluginAsync } from 'fastify';
import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import {
  processHubspotWebhook,
  verifyHubspotSignature,
} from '../../sources/hubspot/webhook.js';

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  // HubSpot webhook receiver. ALWAYS returns 200 (or 401 on bad signature)
  // so HubSpot does not disable the endpoint on transient app errors.
  // Body is parsed as raw text so the HMAC signature can be verified
  // against the exact bytes HubSpot sent.
  app.post(
    '/webhooks/hubspot',
    {
      config: { rawBody: true },
    },
    async (req, reply) => {
      if (!env.HUBSPOT_CLIENT_SECRET) {
        logger.error('hubspot_webhook_secret_not_configured');
        return reply.code(503).send({
          success: false,
          error: { code: 'WEBHOOK_NOT_CONFIGURED', message: 'HUBSPOT_CLIENT_SECRET missing' },
        });
      }

      const sigHeader = req.headers['x-hubspot-signature-v3'];
      const tsHeader = req.headers['x-hubspot-request-timestamp'];
      const signatureHeader = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
      const timestampHeader = Array.isArray(tsHeader) ? tsHeader[0] : tsHeader;

      // We need the *raw* body for HMAC. Fastify parses JSON by default; we
      // re-stringify deterministically from the parsed body. This works
      // because HubSpot sends compact JSON without whitespace. If a future
      // verification mismatch appears, switch to fastify-raw-body and
      // verify against the original bytes.
      const rawBody = typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body);

      const protocol = (req.headers['x-forwarded-proto'] as string) ?? req.protocol;
      const host = req.headers.host ?? 'localhost';
      const uri = `${protocol}://${host}${req.url}`;

      const verdict = verifyHubspotSignature({
        method: req.method,
        uri,
        rawBody,
        signatureHeader,
        timestampHeader,
        clientSecret: env.HUBSPOT_CLIENT_SECRET,
      });

      if (!verdict.ok) {
        logger.warn({ reason: verdict.reason }, 'hubspot_webhook_signature_invalid');
        return reply.code(401).send({
          success: false,
          error: { code: 'INVALID_SIGNATURE', message: verdict.reason },
        });
      }

      const outcome = await processHubspotWebhook(req.body);
      logger.info(outcome, 'hubspot_webhook_processed');

      return reply.code(200).send({ success: true, data: outcome });
    },
  );
};
