import { Temporal } from '@mondapac/shared-kernel';
import {
  dayWindowOf,
  MIN_FUNNEL_BASE,
  shoppingFunnelOf,
  SNAPSHOT_LOOKBACK_DAYS,
  snapshotDaysDue,
  type EngagementDay,
} from './engagement';
import type { MarketDay } from './facts';

const day = (text: string) => text as MarketDay;
const row = (text: string, viewed: number, carted: number, checkedOut: number, paid: number) =>
  ({ day: day(text), viewed, carted, checkedOut, paid }) satisfies EngagementDay;
const range = { from: day('2026-11-01'), to: day('2026-11-30') };

// Both Market fixtures' zones are ahead of UTC (Brisbane +10, Tokyo +9); a zone behind UTC and
// one with daylight saving are checked too, so nothing here leans on the UTC day.
describe.each([['Australia/Brisbane'], ['Asia/Tokyo'], ['America/Los_Angeles']])(
  'the snapshot days in %s',
  (zone) => {
    const startOf = (text: string) =>
      Temporal.PlainDate.from(text).toZonedDateTime({ timeZone: zone }).toInstant();

    it('waits two hours after the Market day ends, then writes it once', () => {
      const end = startOf('2026-11-25');
      const early = snapshotDaysDue(end.add({ minutes: 119 }), zone, new Set());
      expect(early).not.toContain('2026-11-24');
      expect(early.at(-1)).toBe('2026-11-23');
      const due = snapshotDaysDue(end.add({ hours: 2 }), zone, new Set());
      expect(due.at(-1)).toBe('2026-11-24');
      expect(due).toHaveLength(SNAPSHOT_LOOKBACK_DAYS);
      expect(snapshotDaysDue(end.add({ hours: 2 }), zone, new Set(due))).toEqual([]);
    });

    it('goes back 28 days at most, oldest first, skipping the days written', () => {
      const now = startOf('2026-11-25').add({ hours: 3 });
      const due = snapshotDaysDue(now, zone, new Set([day('2026-11-20')]));
      expect(due[0]).toBe('2026-10-28');
      expect(due).not.toContain('2026-11-20');
      expect(due).not.toContain('2026-10-27');
      expect(due).toEqual([...due].sort());
    });

    it('takes a day from its start to the next start in the zone', () => {
      expect(dayWindowOf(day('2026-11-24'), zone)).toEqual({
        from: startOf('2026-11-24'),
        to: startOf('2026-11-25'),
      });
    });
  },
);

it('keeps a daylight-saving day as long as it is in its zone', () => {
  const window = dayWindowOf(day('2026-11-01'), 'America/Los_Angeles');
  expect(window.to.since(window.from).total({ unit: 'hours' })).toBe(25);
});

describe('shoppingFunnelOf', () => {
  it('sums the days and gives each step as a share of the step before', () => {
    const out = shoppingFunnelOf(
      [row('2026-11-01', 60, 20, 10, 8), row('2026-11-02', 40, 10, 6, 4)],
      [row('2026-10-01', 80, 20, 10, 5)],
      range,
    );
    expect(out).toEqual({
      status: 'available',
      viewed: {
        count: 100,
        rateBp: null,
        change: { value: 2500, direction: 'up', state: 'ok' },
        rateChange: { value: 0, direction: 'flat', state: 'na' },
      },
      carted: {
        count: 30,
        rateBp: 3000,
        change: { value: 5000, direction: 'up', state: 'ok' },
        rateChange: { value: 500, direction: 'up', state: 'ok' },
      },
      checkedOut: {
        count: 16,
        rateBp: 5333,
        change: { value: 6000, direction: 'up', state: 'ok' },
        rateChange: { value: 333, direction: 'up', state: 'ok' },
      },
      paid: {
        count: 12,
        rateBp: 7500,
        change: { value: 14000, direction: 'up', state: 'ok' },
        rateChange: { value: 2500, direction: 'up', state: 'ok' },
      },
      recordedDays: 2,
      periodDays: 30,
    });
  });

  it('is not-enough-data below twenty viewers, and gives no change against such a period', () => {
    expect(shoppingFunnelOf([row('2026-11-01', MIN_FUNNEL_BASE - 1, 9, 9, 9)], [], range)).toEqual({
      status: 'not-enough-data',
      minimum: MIN_FUNNEL_BASE,
      recordedDays: 1,
      periodDays: 30,
    });
    const out = shoppingFunnelOf(
      [row('2026-11-01', 40, 10, 5, 5)],
      [row('2026-10-01', 19, 10, 5, 5)],
      range,
    );
    if (out.status !== 'available') throw new Error('expected available');
    expect(out.viewed.change.state).toBe('na');
    expect(out.carted.rateChange.state).toBe('na');
    expect(out.carted.rateBp).toBe(2500);
  });

  it('hides a step under five customers with its rate, and every step after it', () => {
    const out = shoppingFunnelOf([row('2026-11-01', 50, 6, 4, 4)], [], range);
    if (out.status !== 'available') throw new Error('expected available');
    expect(out.carted).toMatchObject({ count: 6, rateBp: 1200 });
    for (const step of [out.checkedOut, out.paid]) {
      expect(step).toEqual({
        count: null,
        rateBp: null,
        change: { value: 0, direction: 'flat', state: 'na' },
        rateChange: { value: 0, direction: 'flat', state: 'na' },
      });
    }
  });

  it('refuses rows whose steps do not nest', () => {
    expect(() => shoppingFunnelOf([row('2026-11-01', 10, 11, 0, 0)], [], range)).toThrow(
      RangeError,
    );
    expect(() => shoppingFunnelOf([], [row('2026-10-01', 10, 5, 2, 3)], range)).toThrow(RangeError);
  });
});
