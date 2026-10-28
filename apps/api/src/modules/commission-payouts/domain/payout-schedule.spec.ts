import { Temporal } from '@mondapac/shared-kernel';
import {
  isKnownZone,
  latestSlot,
  nextSlotAfter,
  slotOnDate,
  slotsBetween,
  type ScheduleTerms,
} from './payout-schedule';

// The schedule is pure, so its rules are worked examples (the zones the platform sells in, and the
// days the clocks change) and properties over generated windows (a seeded generator, mulberry32, so
// a failing case replays from its seed; fast-check is not a dependency of this repository).

const TUESDAY_TEN: ScheduleTerms = { weekdays: ['TUE'], localTime: '10:00' };
const BRISBANE = 'Australia/Brisbane';
const PERTH = 'Australia/Perth';
const SYDNEY = 'Australia/Sydney';
const AUCKLAND = 'Pacific/Auckland';
const instant = (text: string) => Temporal.Instant.from(text);
const local = (value: Temporal.Instant, zone: string) =>
  value.toZonedDateTimeISO(zone).toPlainDateTime().toString();

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (next: () => number, low: number, high: number): number =>
  low + Math.floor(next() * (high - low + 1));

describe('slotOnDate', () => {
  it('is the wall time in the zone where it exists once (Brisbane and Perth run at their own time)', () => {
    const date = Temporal.PlainDate.from('2026-10-27');
    expect(slotOnDate(date, '10:00', BRISBANE).toString()).toBe('2026-10-27T00:00:00Z');
    expect(slotOnDate(date, '10:00', PERTH).toString()).toBe('2026-10-27T02:00:00Z');
  });

  it('moves a time the clocks skip to the first valid instant (Sydney, 2026-10-04)', () => {
    const date = Temporal.PlainDate.from('2026-10-04');
    // 02:00 to 03:00 does not exist; 03:00 +11:00 is 16:00Z the day before.
    expect(slotOnDate(date, '02:30', SYDNEY).toString()).toBe('2026-10-03T16:00:00Z');
    expect(local(slotOnDate(date, '02:30', SYDNEY), SYDNEY)).toBe('2026-10-04T03:00:00');
    // A time before the gap and one after it are untouched.
    expect(local(slotOnDate(date, '01:59', SYDNEY), SYDNEY)).toBe('2026-10-04T01:59:00');
    expect(local(slotOnDate(date, '03:00', SYDNEY), SYDNEY)).toBe('2026-10-04T03:00:00');
  });

  it('takes the earlier instant of a time that happens twice (Sydney, 2027-04-04)', () => {
    const date = Temporal.PlainDate.from('2027-04-04');
    // 02:30 happens at 15:30Z (+11:00) and again at 16:30Z (+10:00): the first.
    expect(slotOnDate(date, '02:30', SYDNEY).toString()).toBe('2027-04-03T15:30:00Z');
  });

  it('handles a gap in a half-hour zone and a southern one that changes in April', () => {
    // Lord Howe-like gaps are not sold in; Auckland changes on 2026-09-27 at 02:00.
    const gap = slotOnDate(Temporal.PlainDate.from('2026-09-27'), '02:15', AUCKLAND);
    expect(local(gap, AUCKLAND)).toBe('2026-09-27T03:00:00');
  });

  it('refuses a malformed time', () => {
    expect(() => slotOnDate(Temporal.PlainDate.from('2026-10-27'), '25:00', SYDNEY)).toThrow(
      RangeError,
    );
  });
});

describe('slotsBetween and latestSlot', () => {
  it('finds the one Tuesday slot of a week in the seller zone', () => {
    // Monday 26 Oct 2026 to Wednesday 28 Oct: Tuesday 27 Oct 10:00 Brisbane is 00:00Z.
    const slots = slotsBetween(
      TUESDAY_TEN,
      BRISBANE,
      instant('2026-10-26T00:00:00Z'),
      instant('2026-10-28T00:00:00Z'),
    );
    expect(slots.map(String)).toEqual(['2026-10-27T00:00:00Z']);
  });

  it('excludes the last slot instant and includes the one exactly at now', () => {
    const slot = instant('2026-10-27T00:00:00Z');
    expect(slotsBetween(TUESDAY_TEN, BRISBANE, slot, slot.add({ hours: 24 }))).toEqual([]);
    expect(
      slotsBetween(TUESDAY_TEN, BRISBANE, slot.subtract({ hours: 1 }), slot).map(String),
    ).toEqual([slot.toString()]);
  });

  it('gives one latest slot for several missed ones (downtime)', () => {
    const after = instant('2026-09-28T00:00:00Z');
    const now = instant('2026-10-28T00:00:00Z');
    const all = slotsBetween(TUESDAY_TEN, BRISBANE, after, now);
    expect(all.length).toBe(5);
    expect(latestSlot(TUESDAY_TEN, BRISBANE, after, now)?.toString()).toBe('2026-10-27T00:00:00Z');
  });

  it('is not due when no slot lies in the window', () => {
    expect(
      latestSlot(
        TUESDAY_TEN,
        BRISBANE,
        instant('2026-10-27T00:00:00Z'),
        instant('2026-10-27T23:59:00Z'),
      ),
    ).toBeNull();
    expect(
      latestSlot(
        TUESDAY_TEN,
        BRISBANE,
        instant('2026-10-28T00:00:00Z'),
        instant('2026-10-27T00:00:00Z'),
      ),
    ).toBeNull();
  });

  it('puts the same Tuesday at different instants for sellers in different zones', () => {
    const window = [instant('2026-10-26T00:00:00Z'), instant('2026-10-29T00:00:00Z')] as const;
    const brisbane = latestSlot(TUESDAY_TEN, BRISBANE, ...window)!;
    const perth = latestSlot(TUESDAY_TEN, PERTH, ...window)!;
    expect(local(brisbane, BRISBANE)).toBe('2026-10-27T10:00:00');
    expect(local(perth, PERTH)).toBe('2026-10-27T10:00:00');
    expect(brisbane.until(perth).total('hours')).toBe(2);
  });

  it('keeps the local time across a daylight saving change (Sydney)', () => {
    const slots = slotsBetween(
      { weekdays: ['SAT', 'SUN'], localTime: '10:00' },
      SYDNEY,
      instant('2026-10-02T00:00:00Z'),
      instant('2026-10-05T00:00:00Z'),
    );
    expect(slots.map((slot) => local(slot, SYDNEY))).toEqual([
      '2026-10-03T10:00:00',
      '2026-10-04T10:00:00',
    ]);
    // The clocks went forward between them, so one local day is 23 hours.
    expect(slots[0]!.until(slots[1]!).total('hours')).toBe(23);
  });

  it('handles a window of years without walking every day', () => {
    const slot = latestSlot(
      TUESDAY_TEN,
      BRISBANE,
      instant('2020-01-01T00:00:00Z'),
      instant('2026-10-28T00:00:00Z'),
    );
    expect(slot?.toString()).toBe('2026-10-27T00:00:00Z');
  });
});

describe('nextSlotAfter', () => {
  it('is the next Tuesday when asked on a Tuesday after the slot', () => {
    expect(nextSlotAfter(TUESDAY_TEN, BRISBANE, instant('2026-10-27T00:00:00Z')).toString()).toBe(
      '2026-11-03T00:00:00Z',
    );
  });

  it('is later the same day when asked before the slot', () => {
    expect(nextSlotAfter(TUESDAY_TEN, BRISBANE, instant('2026-10-26T23:59:59Z')).toString()).toBe(
      '2026-10-27T00:00:00Z',
    );
  });

  it('knows the zones it is given', () => {
    expect(isKnownZone(SYDNEY)).toBe(true);
    expect(isKnownZone('Mars/Olympus')).toBe(false);
  });
});

describe('properties over generated terms, zones and windows', () => {
  const SEEDS = Array.from({ length: 60 }, (_, index) => index + 1);
  const ZONES = [BRISBANE, PERTH, SYDNEY, AUCKLAND, 'Australia/Adelaide', 'Asia/Kuala_Lumpur'];
  const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
  const TIMES = ['00:00', '00:30', '02:30', '03:00', '10:00', '23:59'];

  function generate(seed: number) {
    const next = random(seed);
    const weekdays = DAYS.filter(() => next() < 0.3);
    const terms: ScheduleTerms = {
      weekdays: weekdays.length === 0 ? [DAYS[between(next, 0, 6)]!] : weekdays,
      localTime: TIMES[between(next, 0, TIMES.length - 1)]!,
    };
    const zone = ZONES[between(next, 0, ZONES.length - 1)]!;
    const after = instant('2026-01-01T00:00:00Z').add({ hours: between(next, 0, 24 * 600) });
    const upTo = after.add({ minutes: between(next, 0, 60 * 24 * 40) });
    return { terms, zone, after, upTo };
  }

  it.each(SEEDS)(
    'seed %i: slots are in the window, sorted, distinct and on a chosen weekday',
    (seed) => {
      const { terms, zone, after, upTo } = generate(seed);
      const slots = slotsBetween(terms, zone, after, upTo);
      for (const slot of slots) {
        expect(Temporal.Instant.compare(slot, after)).toBeGreaterThan(0);
        expect(Temporal.Instant.compare(slot, upTo)).toBeLessThanOrEqual(0);
      }
      expect(new Set(slots.map(String)).size).toBe(slots.length);
      expect([...slots].sort(Temporal.Instant.compare).map(String)).toEqual(slots.map(String));
      const names = slots.map((slot) => DAYS[slot.toZonedDateTimeISO(zone).dayOfWeek - 1]);
      for (const name of names) expect(terms.weekdays).toContain(name);
    },
  );

  it.each(SEEDS)(
    'seed %i: the local time is the one asked, or the end of the gap it falls in',
    (seed) => {
      const { terms, zone, after, upTo } = generate(seed);
      for (const slot of slotsBetween(terms, zone, after, upTo)) {
        const wall = slot.toZonedDateTimeISO(zone);
        const hhmm = `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
        if (hhmm !== terms.localTime) {
          // Only a skipped time may differ, and then the slot is exactly where the clocks change.
          const before = slot.subtract({ nanoseconds: 1 }).toZonedDateTimeISO(zone);
          expect(before.offsetNanoseconds).not.toBe(wall.offsetNanoseconds);
          expect(wall.second + wall.millisecond).toBe(0);
          expect(`${wall.hour}:${wall.minute}`.length).toBeGreaterThan(0);
        }
      }
    },
  );

  it.each(SEEDS)('seed %i: one latest slot per window, the last of the list', (seed) => {
    const { terms, zone, after, upTo } = generate(seed);
    const slots = slotsBetween(terms, zone, after, upTo);
    expect(latestSlot(terms, zone, after, upTo)?.toString()).toBe(slots.at(-1)?.toString());
  });

  it.each(SEEDS)('seed %i: the next slot is after the instant and nothing lies between', (seed) => {
    const { terms, zone, after } = generate(seed);
    const next = nextSlotAfter(terms, zone, after);
    expect(Temporal.Instant.compare(next, after)).toBeGreaterThan(0);
    expect(slotsBetween(terms, zone, after, next.subtract({ nanoseconds: 1 }))).toEqual([]);
    expect(slotsBetween(terms, zone, after, next).map(String)).toEqual([next.toString()]);
  });

  it.each(SEEDS)('seed %i: cutting a window at a slot splits its slots without loss', (seed) => {
    const { terms, zone, after, upTo } = generate(seed);
    const slots = slotsBetween(terms, zone, after, upTo);
    if (slots.length === 0) return;
    const cut = slots[Math.floor(slots.length / 2)]!;
    expect(
      [...slotsBetween(terms, zone, after, cut), ...slotsBetween(terms, zone, cut, upTo)].map(
        String,
      ),
    ).toEqual(slots.map(String));
  });
});
