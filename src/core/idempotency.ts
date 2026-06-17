import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { NormalizedRecord } from '../sources/types.js';

export interface UpsertResult {
  /** True when the row was inserted OR its content changed (a write occurred). */
  written: boolean;
}

/**
 * SHA-256 of the canonical JSON of a payload. Canonical means keys are
 * recursively sorted, so {"b":2,"a":1} and {"a":1,"b":2} produce the same
 * hash. This is the input to the skip-if-unchanged guard in upsertRecord.
 */
export function computePayloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Idempotent upsert. The WHERE clause makes this a no-op when the record's
 * content hasn't changed — repeated calls produce zero writes, no synced_at
 * churn. Safe under webhook replays and back-to-back sync runs.
 *
 * Returns { written: true } when a row was inserted or updated.
 * Returns { written: false } when the existing row had an identical hash.
 */
export async function upsertRecord(
  client: Pool | PoolClient,
  record: NormalizedRecord,
): Promise<UpsertResult> {
  const hash = computePayloadHash(record.payload);

  const result = await client.query<{ id: string }>(
    `
    INSERT INTO records (
      source, source_record_id, entity_type, payload, payload_hash, source_updated_at
    ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
    ON CONFLICT (source, source_record_id) DO UPDATE
      SET entity_type       = EXCLUDED.entity_type,
          payload           = EXCLUDED.payload,
          payload_hash      = EXCLUDED.payload_hash,
          source_updated_at = EXCLUDED.source_updated_at,
          synced_at         = NOW()
      WHERE records.payload_hash != EXCLUDED.payload_hash
    RETURNING id
    `,
    [
      record.source,
      record.sourceRecordId,
      record.entityType,
      JSON.stringify(record.payload),
      hash,
      record.sourceUpdatedAt,
    ],
  );

  return { written: result.rows.length > 0 };
}
