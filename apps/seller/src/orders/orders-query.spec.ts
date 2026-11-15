import { describe, expect, it } from 'vitest';
import { queryOf, startOfDay } from './orders-query.ts';

describe("startOfDay on the seller's clock (ADR-0005)", () => {
  it('starts a day at local midnight in the zone of either Market', () => {
    expect(startOfDay('2026-10-01', 'Australia/Brisbane')).toBe('2026-09-30T14:00:00.000Z');
    expect(startOfDay('2026-10-01', 'Asia/Tokyo')).toBe('2026-09-30T15:00:00.000Z');
    expect(startOfDay('2026-10-31', 'Australia/Brisbane', 1)).toBe('2026-10-31T14:00:00.000Z');
  });

  it('follows daylight saving and a skipped midnight', () => {
    expect(startOfDay('2026-10-05', 'Australia/Sydney')).toBe('2026-10-04T13:00:00.000Z');
    expect(startOfDay('2026-09-06', 'America/Santiago')).toBe('2026-09-06T04:00:00.000Z');
  });

  it('answers null for a day or zone that is not real', () => {
    expect(startOfDay('2026-02-30', 'UTC')).toBeNull();
    expect(startOfDay('2026-10-01', 'Mars/Olympus')).toBeNull();
  });
});

describe('queryOf', () => {
  it('sends the local days as instants', () => {
    expect(
      queryOf('all', { from: '2026-10-01', to: '2026-10-01' }, 'Asia/Tokyo', {
        paging: 'prev-next',
        cursor: null,
      }),
    ).toBe(
      'ordering/seller/orders?limit=20&from=2026-09-30T15%3A00%3A00.000Z' +
        '&to=2026-10-01T15%3A00%3A00.000Z',
    );
  });
});
