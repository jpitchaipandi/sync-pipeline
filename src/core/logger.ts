import { pino } from 'pino';
import { env } from '../config/env.js';

const isDev = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'sync-pipeline',
    env: env.NODE_ENV,
  },
  redact: {
    paths: [
      '*.access_token',
      '*.refresh_token',
      '*.api_key',
      '*.client_secret',
      'req.headers.authorization',
      'req.headers["x-hubspot-signature-v3"]',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
});

export type Logger = typeof logger;
