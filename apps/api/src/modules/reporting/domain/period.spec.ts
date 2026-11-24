import { Temporal } from '@mondapac/shared-kernel';
import {
  dayStartsOf,
  daysOf,
  delta,
  earliestFrom,
  isPeriodId,
  MAX_RANGE_DAYS,
  parsePeriodQuery,
  resolvePeriod,
  resolvePeriodRequest,
} from './period';
import type { MarketDay } from './facts';

const day = (text: string) => text as MarketDay;

describe('resolvePeriod', () => {
  it('today against yesterday', () => {
    const p = resolvePeriod('today', day('2026-11-22'));
    expect(p.current).toEqual({ from: '2026-11-22', to: '2026-11-22' });
    expect(p.previous).toEqual({ from: '2026-11-21', to: '2026-11-21' });
    expect(p.days).toBe(1);
  });

  it('7 and 30 days end today and the previous range is as long, just before', () => {
    const seven = resolvePeriod('7d', day('2026-11-22'));
    expect(seven.current).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(seven.previous).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    const thirty = resolvePeriod('30d', day('2026-03-05'));
    expect(thirty.current).toEqual({ from: '2026-02-04', to: '2026-03-05' });
    expect(thirty.previous).toEqual({ from: '2026-01-05', to: '2026-02-03' });
    expect(daysOf(thirty.current)).toHaveLength(30);
    expect(daysOf(thirty.previous)).toHaveLength(30);
  });

  it('the month so far against the same number of days of the previous month', () => {
    const p = resolvePeriod('month', day('2026-11-22'));
    expect(p.current).toEqual({ from: '2026-11-01', to: '2026-11-22' });
    expect(p.previous).toEqual({ from: '2026-10-01', to: '2026-10-22' });
    expect(p.days).toBe(22);
  });

  it('cuts the previous month at its end when it is shorter', () => {
    const p = resolvePeriod('month', day('2026-03-31'));
    expect(p.previous).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(p.days).toBe(31);
  });

  it('crosses a year', () => {
    const p = resolvePeriod('month', day('2027-01-10'));
    expect(p.previous).toEqual({ from: '2026-12-01', to: '2026-12-10' });
  });
});

describe('daysOf', () => {
  it('lists every day, oldest first', () => {
    expect(daysOf({ from: day('2026-02-27'), to: day('2026-03-02') })).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });
});

describe('delta', () => {
  it('is in basis points with a direction', () => {
    expect(delta(1125n, 1000n)).toEqual({ value: 1250, direction: 'up', state: 'ok' });
    expect(delta(750, 1000)).toEqual({ value: -2500, direction: 'down', state: 'ok' });
    expect(delta(5, 5)).toEqual({ value: 0, direction: 'flat', state: 'ok' });
  });

  it('is n/a on a zero or tiny base', () => {
    expect(delta(10, 0).state).toBe('na');
    expect(delta(10, 3, 5).state).toBe('na');
    expect(delta(10, 5, 5).state).toBe('ok');
  });
});

describe('isPeriodId', () => {
  it('accepts only the four periods', () => {
    expect(['today', '7d', '30d', 'month'].every(isPeriodId)).toBe(true);
    expect(isPeriodId('year')).toBe(false);
    expect(isPeriodId(7)).toBe(false);
  });
});

describe('custom ranges (dashboards v2, PR 5)', () => {
  const today = day('2026-11-24');

  it('reads a preset, the default, or a custom range from the query', () => {
    expect(parsePeriodQuery({}, '7d')).toEqual({ ok: true, value: '7d' });
    expect(parsePeriodQuery({ period: 'month' }, '7d')).toEqual({ ok: true, value: 'month' });
    expect(parsePeriodQuery({ from: '2026-10-01', to: '2026-10-31' }, '7d')).toEqual({
      ok: true,
      value: { from: '2026-10-01', to: '2026-10-31' },
    });
    expect(
      parsePeriodQuery({ period: 'custom', from: '2026-10-01', to: '2026-10-01' }, '7d'),
    ).toEqual({ ok: true, value: { from: '2026-10-01', to: '2026-10-01' } });
  });

  it.each([
    [{ period: 'year' }, [{ path: 'period', code: 'enum' }]],
    [
      { period: 'custom' },
      [
        { path: 'from', code: 'required' },
        { path: 'to', code: 'required' },
      ],
    ],
    [{ from: '2026-10-01' }, [{ path: 'to', code: 'required' }]],
    [{ period: '7d', from: '2026-10-01', to: '2026-10-02' }, [{ path: 'period', code: 'enum' }]],
    [{ from: '2026-02-30', to: '2026-03-01' }, [{ path: 'from', code: 'format' }]],
    [{ from: '2026-1-01', to: '2026-03-01' }, [{ path: 'from', code: 'format' }]],
    [{ from: ['2026-01-01'], to: '2026-03-01' }, [{ path: 'from', code: 'format' }]],
    [{ from: '2026-10-02', to: '2026-10-01' }, [{ path: 'from', code: 'after-to' }]],
    [{ from: '2025-10-24', to: '2026-11-24' }, [{ path: 'from', code: 'too-long' }]],
  ])('refuses %j', (query, fields) => {
    expect(parsePeriodQuery(query, '7d')).toEqual({ ok: false, error: fields });
  });

  it('caps a range at 13 calendar months, inclusive', () => {
    // 2025-10-25 .. 2026-11-24 is exactly 13 months (396 days).
    expect(earliestFrom(today)).toBe('2025-10-25');
    expect(parsePeriodQuery({ from: '2025-10-25', to: '2026-11-24' }, '7d').ok).toBe(true);
    expect(parsePeriodQuery({ from: '2025-10-24', to: '2026-11-24' }, '7d').ok).toBe(false);
    // A month end: 13 months back from 31 March is 1 March of the year before.
    expect(earliestFrom(day('2026-03-31'))).toBe('2025-03-01');
    expect(earliestFrom(day('2024-02-29'))).toBe('2023-01-30');
    const longest = resolvePeriodRequest({ from: day('2025-03-01'), to: day('2026-03-31') }, today);
    expect(longest).toMatchObject({ ok: true, value: { days: 396 } });
    // Never more than MAX_RANGE_DAYS, whatever the month lengths.
    for (const to of ['2026-01-31', '2026-02-28', '2028-02-29', '2026-07-31', '2026-12-31']) {
      const from = earliestFrom(day(to));
      expect(daysOf({ from, to: day(to) }).length).toBeLessThanOrEqual(MAX_RANGE_DAYS);
    }
  });

  it('refuses a range that ends after the Market day of today', () => {
    expect(resolvePeriodRequest({ from: day('2026-11-20'), to: day('2026-11-25') }, today)).toEqual(
      {
        ok: false,
        error: [{ path: 'to', code: 'future' }],
      },
    );
    expect(resolvePeriodRequest({ from: day('2026-11-24'), to: day('2026-11-24') }, today).ok).toBe(
      true,
    );
  });

  it('compares a custom range with as many days just before it', () => {
    const resolved = resolvePeriodRequest(
      { from: day('2026-03-01'), to: day('2026-03-31') },
      today,
    );
    expect(resolved).toEqual({
      ok: true,
      value: {
        id: 'custom',
        current: { from: '2026-03-01', to: '2026-03-31' },
        previous: { from: '2026-01-29', to: '2026-02-28' },
        days: 31,
      },
    });
    const one = resolvePeriodRequest({ from: day('2026-01-01'), to: day('2026-01-01') }, today);
    expect(one).toMatchObject({
      ok: true,
      value: { previous: { from: '2025-12-31', to: '2025-12-31' }, days: 1 },
    });
  });

  it('resolves a preset as before', () => {
    expect(resolvePeriodRequest('7d', today)).toEqual({
      ok: true,
      value: resolvePeriod('7d', today),
    });
  });

  it('counts the days of a range over a daylight-saving change as calendar days', () => {
    // Sydney leaves DST on 5 April 2026 (a 25-hour day) and Brisbane has none: a day is a day.
    const range = { from: day('2026-04-04'), to: day('2026-04-06') };
    expect(resolvePeriodRequest(range, today)).toMatchObject({
      ok: true,
      value: { days: 3, previous: { from: '2026-04-01', to: '2026-04-03' } },
    });
    expect(dayStartsOf(range, 'Australia/Sydney')).toEqual({
      start: Temporal.Instant.from('2026-04-03T13:00:00Z'),
      end: Temporal.Instant.from('2026-04-06T14:00:00Z'),
    });
    expect(dayStartsOf(range, 'Pacific/Auckland')).toEqual({
      start: Temporal.Instant.from('2026-04-03T11:00:00Z'),
      end: Temporal.Instant.from('2026-04-06T12:00:00Z'),
    });
  });
});
