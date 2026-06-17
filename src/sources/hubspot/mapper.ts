import { z } from 'zod';
import { PayloadValidationError } from '../../core/errors.js';
import type { NormalizedRecord } from '../types.js';

export type HubspotEntityType = 'contact' | 'company' | 'deal';

/**
 * Shared shape across HubSpot CRM objects (contacts, companies, deals).
 * Every CRM v3 endpoint returns this envelope; only the `properties` keys differ.
 */
const HubspotObjectSchema = z.object({
  id: z.string().min(1),
  properties: z.record(z.string(), z.string().nullable()),
  createdAt: z.union([z.string(), z.date()]).optional(),
  updatedAt: z.union([z.string(), z.date()]).optional(),
});

export type HubspotObject = z.infer<typeof HubspotObjectSchema>;

const HS_ENTITY_TO_TYPE: Record<HubspotEntityType, string> = {
  contact: 'contact',
  company: 'company',
  deal: 'deal',
};

/**
 * Convert a HubSpot CRM object into a NormalizedRecord ready for upsert.
 * Throws PayloadValidationError if the payload doesn't match the schema.
 *
 * `hs_lastmodifieddate` (returned as an epoch-ms string by HubSpot) is parsed
 * into a Date for `sourceUpdatedAt`. If missing, we fall back to the SDK's
 * `updatedAt` field, then null.
 */
export function mapHubspotObject(
  entityType: HubspotEntityType,
  raw: unknown,
): NormalizedRecord {
  const parsed = HubspotObjectSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PayloadValidationError(
      'hubspot',
      typeof (raw as { id?: unknown })?.id === 'string'
        ? (raw as { id: string }).id
        : 'unknown',
      parsed.error.issues,
    );
  }

  const obj = parsed.data;
  const sourceUpdatedAt = extractUpdatedAt(obj);

  return {
    source: 'hubspot',
    sourceRecordId: obj.id,
    entityType: HS_ENTITY_TO_TYPE[entityType],
    payload: {
      id: obj.id,
      ...obj.properties,
    },
    sourceUpdatedAt,
  };
}

function extractUpdatedAt(obj: HubspotObject): Date | null {
  const lastModified = obj.properties['hs_lastmodifieddate'];
  if (lastModified) {
    const ms = Number(lastModified);
    if (!Number.isNaN(ms)) return new Date(ms);
    const iso = new Date(lastModified);
    if (!Number.isNaN(iso.getTime())) return iso;
  }
  if (obj.updatedAt) {
    return obj.updatedAt instanceof Date ? obj.updatedAt : new Date(obj.updatedAt);
  }
  return null;
}
