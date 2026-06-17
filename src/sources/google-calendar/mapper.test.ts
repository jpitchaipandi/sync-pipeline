import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PayloadValidationError } from '../../core/errors.js';
import { mapCalendarEvent } from './mapper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', '..', '__fixtures__', 'google-calendar');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

describe('mapCalendarEvent', () => {
  it('maps a timed event into a NormalizedRecord', () => {
    const record = mapCalendarEvent(loadFixture('timed-event'));
    expect(record.source).toBe('google-calendar');
    expect(record.entityType).toBe('event');
    expect(record.sourceRecordId).toBe('evt_abc123');
    expect(record.payload['summary']).toBe('Team standup');
    expect(record.sourceUpdatedAt?.toISOString()).toBe('2026-02-28T22:00:00.000Z');
  });

  it('preserves both dateTime and timezone on timed events', () => {
    const record = mapCalendarEvent(loadFixture('timed-event'));
    const start = record.payload['start'] as Record<string, string>;
    expect(start.dateTime).toBe('2026-03-01T09:00:00-08:00');
    expect(start.timeZone).toBe('America/Los_Angeles');
  });

  it('maps an all-day event (uses start.date, no dateTime)', () => {
    const record = mapCalendarEvent(loadFixture('all-day-event'));
    const start = record.payload['start'] as Record<string, string>;
    expect(start.date).toBe('2026-04-15');
    expect(start.dateTime).toBeUndefined();
  });

  it('maps a cancelled event with minimal payload', () => {
    const record = mapCalendarEvent(loadFixture('cancelled-event'));
    expect(record.sourceRecordId).toBe('evt_cancelled_789');
    expect(record.payload['status']).toBe('cancelled');
    expect(record.payload['summary']).toBeNull();
  });

  it('maps a recurring event instance with recurringEventId', () => {
    const record = mapCalendarEvent(loadFixture('recurring-instance'));
    expect(record.payload['recurringEventId']).toBe('evt_recurring_master');
    expect(record.payload['originalStartTime']).toBeDefined();
  });

  it('throws PayloadValidationError when id is missing', () => {
    const bad = { summary: 'no id' };
    expect(() => mapCalendarEvent(bad)).toThrow(PayloadValidationError);
  });

  it('throws PayloadValidationError on invalid status enum', () => {
    const bad = { id: 'x', status: 'invalid-status' };
    expect(() => mapCalendarEvent(bad)).toThrow(PayloadValidationError);
  });
});
