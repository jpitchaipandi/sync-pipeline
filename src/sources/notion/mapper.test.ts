import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PayloadValidationError } from '../../core/errors.js';
import { mapNotionPage } from './mapper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', '..', '__fixtures__', 'notion');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

describe('mapNotionPage', () => {
  it('maps a normal page into a NormalizedRecord', () => {
    const record = mapNotionPage(loadFixture('page'));
    expect(record.source).toBe('notion');
    expect(record.entityType).toBe('page');
    expect(record.sourceRecordId).toBe('abc123de-f456-7890-abcd-ef0123456789');
    expect(record.sourceUpdatedAt?.toISOString()).toBe('2026-03-01T14:30:00.000Z');
  });

  it('extracts the title from the properties block', () => {
    const record = mapNotionPage(loadFixture('page'));
    expect(record.payload['title']).toBe('Read Domain-Driven Design');
  });

  it('preserves the full properties object verbatim', () => {
    const record = mapNotionPage(loadFixture('page'));
    const props = record.payload['properties'] as Record<string, { type: string }>;
    expect(props['Status']?.type).toBe('select');
    expect(props['Priority']?.type).toBe('number');
  });

  it('flags archived pages without dropping them', () => {
    const record = mapNotionPage(loadFixture('archived-page'));
    expect(record.payload['archived']).toBe(true);
    expect(record.sourceRecordId).toBe('deletedab-1234-5678-90ab-cdef12345678');
  });

  it('returns null title when no title property exists', () => {
    const raw = {
      id: 'no-title-1234',
      last_edited_time: '2026-03-01T00:00:00.000Z',
      properties: {
        Description: { type: 'rich_text', rich_text: [] },
      },
    };
    const record = mapNotionPage(raw);
    expect(record.payload['title']).toBeNull();
  });

  it('throws PayloadValidationError when last_edited_time is missing', () => {
    const bad = { id: 'x', properties: {} };
    expect(() => mapNotionPage(bad)).toThrow(PayloadValidationError);
  });

  it('throws PayloadValidationError when id is missing', () => {
    const bad = { last_edited_time: '2026-03-01T00:00:00Z', properties: {} };
    expect(() => mapNotionPage(bad)).toThrow(PayloadValidationError);
  });
});
