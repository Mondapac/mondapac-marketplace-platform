import { daysOf, delta, isPeriodId, resolvePeriod } from './period';
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
