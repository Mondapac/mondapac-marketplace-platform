import { money, Temporal } from '@mondapac/shared-kernel';
import { SequenceIdGenerator } from '@mondapac/shared-kernel/testing';
import { daysAtPrice } from './price-history';
import type { PriceSeries } from './price-series';
import {
  PRICING_FIXTURES,
  amountOf,
  newClock,
  newSeries,
} from '../../../../test/support/pricing-fixtures';

// Days at a price (the was-price fact), on both Market fixtures, built through the series' own
// writes so the records carry the effective periods the aggregate gives them.
describe.each(PRICING_FIXTURES)('daysAtPrice in market $code', (fixture) => {
  const { policy } = fixture;
  const start = Temporal.Instant.from('2026-06-01T00:00:00Z');

  function setUp() {
    const clock = newClock();
    clock.set(start);
    const ids = new SequenceIdGenerator(clock);
    const seller = ids.next<'Account'>();
    const series = newSeries(fixture, clock, ids);
    const after = (days: number) => start.add({ hours: days * 24 });
    const at = (days: number) => clock.set(after(days));
    const setRegular = (minor: bigint) => {
      const result = series.setRegularPrice({
        recordId: ids.next<'RegularPriceRecord'>(),
        amount: amountOf(fixture, minor),
        submittedBy: seller,
        taxInclusive: fixture.taxInclusive,
        now: clock.now(),
        policy,
      });
      if (!result.ok || result.value.kind === 'unchanged') throw new Error('setup');
      return result.value.kind;
    };
    const setSpecial = (minor: bigint, fromDay: number, toDay: number) => {
      const result = series.setSpecialPrice({
        recordId: ids.next<'SpecialPriceRecord'>(),
        amount: amountOf(fixture, minor),
        submittedBy: seller,
        taxInclusive: fixture.taxInclusive,
        startsAt: after(fromDay),
        endsAt: after(toDay),
        now: clock.now(),
        policy,
      });
      if (!result.ok || result.value.kind !== 'accepted') throw new Error('setup: special');
    };
    const days = (s: PriceSeries, minor: bigint, fromDay: number, toDay: number) =>
      daysAtPrice(s.state, money(minor, policy.currency), after(fromDay), after(toDay));
    return { series, at, after, setRegular, setSpecial, days };
  }

  const base = fixture.base;
  const raised = (base * 110n) / 100n;
  const discounted = (base * 90n) / 100n;

  it('counts the whole days a regular price was in force', () => {
    const t = setUp();
    t.setRegular(base);
    expect(t.days(t.series, base, 0, 90)).toBe(90);
    expect(t.days(t.series, base, 50, 90)).toBe(40);
  });

  it('splits the window at a regular price change', () => {
    const t = setUp();
    t.setRegular(base);
    t.at(30);
    expect(t.setRegular(raised)).toBe('accepted');
    expect(t.days(t.series, base, 0, 90)).toBe(30);
    expect(t.days(t.series, raised, 0, 90)).toBe(60);
  });

  it('counts the days a special was the effective price, and not for the regular price', () => {
    const t = setUp();
    t.setRegular(base);
    t.setSpecial(discounted, 10, 17);
    expect(t.days(t.series, discounted, 0, 90)).toBe(7);
    expect(t.days(t.series, base, 0, 90)).toBe(83);
  });

  it('counts no time before the first price and floors a part day', () => {
    const t = setUp();
    t.at(80);
    t.setRegular(base);
    // In force from day 80 to day 90 less 12 hours: 9.5 days, so 9.
    const end = t.after(90).subtract({ hours: 12 });
    expect(daysAtPrice(t.series.state, money(base, policy.currency), t.after(0), end)).toBe(9);
  });

  it('never counts a held price that was not approved', () => {
    const t = setUp();
    t.setRegular(base);
    t.at(5);
    expect(t.setRegular(base * 3n)).toBe('held');
    expect(t.days(t.series, base * 3n, 0, 90)).toBe(0);
    expect(t.days(t.series, base, 0, 90)).toBe(90);
  });

  it('counts a retired series until its retirement', () => {
    const t = setUp();
    t.setRegular(base);
    t.series.retire('offer-removed', t.after(20));
    expect(t.days(t.series, base, 0, 90)).toBe(20);
    expect(t.days(t.series, base, 20, 90)).toBe(0);
  });

  it('answers 0 for another currency and for an empty window', () => {
    const t = setUp();
    t.setRegular(base);
    const other = policy.currency === 'AUD' ? 'JPY' : 'AUD';
    expect(daysAtPrice(t.series.state, money(base, other), t.after(0), t.after(90))).toBe(0);
    expect(t.days(t.series, base, 10, 10)).toBe(0);
    expect(t.days(t.series, base, 20, 10)).toBe(0);
  });

  it('never answers more days than the window holds', () => {
    const t = setUp();
    t.setRegular(base);
    t.at(100);
    expect(t.days(t.series, base, 10, 100)).toBe(90);
  });
});
