import { describe, expect, it } from 'vitest';
import { instantToLocal, localToInstant } from './zone-time.ts';

describe('instantToLocal', () => {
  it('reads an instant on the wall clock of the zone', () => {
    expect(instantToLocal('2026-10-26T14:00:00Z', 'Australia/Brisbane')).toBe('2026-10-27T00:00');
    expect(instantToLocal('2026-11-03T13:59:00Z', 'Australia/Brisbane')).toBe('2026-11-03T23:59');
    expect(instantToLocal('2026-10-26T14:00:00Z', 'UTC')).toBe('2026-10-26T14:00');
  });

  it('follows daylight saving in the zone', () => {
    expect(instantToLocal('2026-07-01T00:00:00Z', 'Australia/Sydney')).toBe('2026-07-01T10:00');
    expect(instantToLocal('2026-12-01T00:00:00Z', 'Australia/Sydney')).toBe('2026-12-01T11:00');
  });

  it('is empty for something that is not an instant', () => {
    expect(instantToLocal('', 'UTC')).toBe('');
    expect(instantToLocal('soon', 'UTC')).toBe('');
  });
});

describe('localToInstant', () => {
  it('turns a wall-clock time of the zone into an instant', () => {
    expect(localToInstant('2026-10-27T00:00', 'Australia/Brisbane')).toBe(
      '2026-10-26T14:00:00.000Z',
    );
    expect(localToInstant('2026-12-01T11:00', 'Australia/Sydney')).toBe('2026-12-01T00:00:00.000Z');
    expect(localToInstant('2026-07-01T10:00', 'Australia/Sydney')).toBe('2026-07-01T00:00:00.000Z');
  });

  it('round-trips through the field value', () => {
    for (const zone of ['UTC', 'Australia/Brisbane', 'Australia/Sydney', 'America/New_York']) {
      for (const local of ['2026-03-01T08:30', '2026-10-27T23:59', '2026-11-03T00:00']) {
        const instant = localToInstant(local, zone);
        expect(instant, `${zone} ${local}`).not.toBeNull();
        expect(instantToLocal(instant ?? '', zone)).toBe(local);
      }
    }
  });

  it('refuses a value of another shape or a day that does not exist', () => {
    expect(localToInstant('', 'UTC')).toBeNull();
    expect(localToInstant('2026-10-27', 'UTC')).toBeNull();
    expect(localToInstant('2026-02-31T10:00', 'UTC')).toBeNull();
  });
});
