import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Load .env.local first (gitignored, real secrets), then fall back to .env.
// In production (Render), env vars come from the dashboard and neither file exists — that's fine.
loadDotenv({ path: ['.env.local', '.env'] });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().url(),
  DATABASE_URL_DIRECT: z.string().url().optional(),

  API_SECRET: z.string().min(32).optional(),

  HUBSPOT_ACCESS_TOKEN: z.string().optional(),
  HUBSPOT_CLIENT_SECRET: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().default('primary'),

  NOTION_API_KEY: z.string().optional(),
  NOTION_DATABASE_ID: z.string().optional(),

  WEB_SERVICE_URL: z.string().url().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
