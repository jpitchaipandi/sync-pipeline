import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PayloadValidationError } from '../../core/errors.js';
import { mapHubspotObject } from './mapper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', '..', '__fixtures__', 'hubspot');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

describe('mapHubspotObject', () => {
  it('maps a contact fixture into a NormalizedRecord', () => {
    const raw = loadFixture('contact');
    const record = mapHubspotObject('contact', raw);

    expect(record.source).toBe('hubspot');
    expect(record.sourceRecordId).toBe('12345');
    expect(record.entityType).toBe('contact');
    expect(record.payload).toMatchObject({
      id: '12345',
      email: 'alice@example.com',
      firstname: 'Alice',
    });
    expect(record.sourceUpdatedAt).toBeInstanceOf(Date);
  });

  it('maps a company fixture', () => {
    const record = mapHubspotObject('company', loadFixture('company'));
    expect(record.sourceRecordId).toBe('67890');
    expect(record.entityType).toBe('company');
    expect(record.payload).toMatchObject({ name: 'Example Industries' });
  });

  it('maps a deal fixture', () => {
    const record = mapHubspotObject('deal', loadFixture('deal'));
    expect(record.sourceRecordId).toBe('55555');
    expect(record.entityType).toBe('deal');
    expect(record.payload).toMatchObject({
      dealname: 'Acme Deal Q1',
      amount: '10000.00',
    });
  });

  it('parses hs_lastmodifieddate epoch-ms into Date', () => {
    const record = mapHubspotObject('contact', loadFixture('contact'));
    expect(record.sourceUpdatedAt?.toISOString()).toBe('2024-03-01T00:00:00.000Z');
  });

  it('throws PayloadValidationError when id is missing', () => {
    const bad = { properties: { email: 'noop@example.com' } };
    expect(() => mapHubspotObject('contact', bad)).toThrow(PayloadValidationError);
  });

  it('throws PayloadValidationError when properties is missing', () => {
    const bad = { id: '999' };
    expect(() => mapHubspotObject('contact', bad)).toThrow(PayloadValidationError);
  });

  it('preserves null property values in payload', () => {
    const raw = {
      id: '111',
      properties: { firstname: 'Bob', lastname: null, hs_lastmodifieddate: '1709251200000' },
    };
    const record = mapHubspotObject('contact', raw);
    expect(record.payload['lastname']).toBeNull();
  });
});
