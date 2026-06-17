import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { pool, closePool } from '../db/client.js';
import type { NormalizedRecord } from '../sources/types.js';
import { computePayloadHash, upsertRecord } from './idempotency.js';

describe('computePayloadHash', () => {
  it('returns a 64-char hex SHA-256 string', () => {
    const hash = computePayloadHash({ id: 'abc', value: 1 });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic regardless of key order', () => {
    const a = computePayloadHash({ a: 1, b: 2, c: 3 });
    const b = computePayloadHash({ c: 3, b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('produces different hashes for different content', () => {
    const a = computePayloadHash({ id: 'x', value: 1 });
    const b = computePayloadHash({ id: 'x', value: 2 });
    expect(a).not.toBe(b);
  });

  it('handles nested objects with sorted keys', () => {
    const a = computePayloadHash({ outer: { z: 1, a: 2 } });
    const b = computePayloadHash({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('handles arrays preserving order', () => {
    const a = computePayloadHash({ list: [1, 2, 3] });
    const b = computePayloadHash({ list: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  it('handles null values', () => {
    const hash = computePayloadHash({ value: null });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Integration tests against real Neon DB using transaction rollback.
// Each test runs inside a transaction that ROLLBACKs in afterEach,
// so test data never pollutes the schema.
describe('upsertRecord', () => {
  let client: PoolClient;

  const makeRecord = (overrides: Partial<NormalizedRecord> = {}): NormalizedRecord => ({
    source: 'hubspot',
    sourceRecordId: `test-${crypto.randomUUID()}`,
    entityType: 'contact',
    payload: { email: 'alice@example.com', firstName: 'Alice' },
    sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });

  beforeAll(async () => {
    // Sanity: confirm we can connect before any test runs.
    const test = await pool.query('SELECT 1');
    expect(test.rowCount).toBe(1);
  });

  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    client.release();
  });

  afterAll(async () => {
    await closePool();
  });

  it('inserts a new record (written: true)', async () => {
    const record = makeRecord();
    const result = await upsertRecord(client, record);
    expect(result.written).toBe(true);

    const rows = await client.query(
      'SELECT entity_type, payload_hash FROM records WHERE source=$1 AND source_record_id=$2',
      [record.source, record.sourceRecordId],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].entity_type).toBe('contact');
  });

  it('skips an unchanged upsert (written: false)', async () => {
    const record = makeRecord();
    const first = await upsertRecord(client, record);
    expect(first.written).toBe(true);

    const second = await upsertRecord(client, record);
    expect(second.written).toBe(false);
  });

  it('updates when payload content changes (written: true)', async () => {
    const record = makeRecord();
    await upsertRecord(client, record);

    const updated: NormalizedRecord = {
      ...record,
      payload: { ...record.payload, firstName: 'Alicia' },
    };
    const result = await upsertRecord(client, updated);
    expect(result.written).toBe(true);

    const rows = await client.query<{ payload: { firstName: string } }>(
      'SELECT payload FROM records WHERE source=$1 AND source_record_id=$2',
      [record.source, record.sourceRecordId],
    );
    expect(rows.rows[0]?.payload.firstName).toBe('Alicia');
  });

  it('is a no-op when keys are reordered but content is identical', async () => {
    const record = makeRecord({ payload: { a: 1, b: 2, c: 3 } });
    await upsertRecord(client, record);

    const reordered: NormalizedRecord = {
      ...record,
      payload: { c: 3, b: 2, a: 1 },
    };
    const result = await upsertRecord(client, reordered);
    expect(result.written).toBe(false);
  });
});
