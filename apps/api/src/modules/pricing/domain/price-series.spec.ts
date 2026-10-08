import { Temporal } from '@mondapac/shared-kernel';
import { SequenceIdGenerator } from '@mondapac/shared-kernel/testing';
import { effectiveRegular, jumpAnchor } from './price-series';
import type { PriceSeries, RegularPriceRecord } from './price-series';
import {
  PRICING_FIXTURES,
  amountOf,
  newClock,
  newSeries,
} from '../../../../test/support/pricing-fixtures';

describe.each(PRICING_FIXTURES)('PriceSeries in market $code', (fixture) => {
  const { policy } = fixture;
  const n = policy.thresholdNumerator;
  const d = policy.thresholdDenominator;
  const clock = newClock();
  const ids = new SequenceIdGenerator(clock);
  const account = ids.next<'Account'>();
  const heldUp = (base: bigint): bigint => (base * (d + n)) / d + 1n;

  function setup(): {
    series: PriceSeries;
    set: (minor: bigint) => ReturnType<PriceSeries['setRegularPrice']>;
  } {
    const series = newSeries(fixture, clock, ids);
    return {
      series,
      set: (minor) =>
        series.setRegularPrice({
          recordId: ids.next<'RegularPriceRecord'>(),
          amount: amountOf(fixture, minor),
          submittedBy: account,
          taxInclusive: fixture.taxInclusive,
          now: clock.now(),
          policy,
        }),
    };
  }
  const outcomeOf = (result: ReturnType<PriceSeries['setRegularPrice']>) => {
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };
  const advance = (ms: number) => clock.set(clock.now().add({ milliseconds: ms }));

  beforeEach(() => clock.set(Temporal.Instant.from('2026-10-08T10:00:00Z')));

  it('has no valid price before the first write', () => {
    const { series } = setup();
    expect(effectiveRegular(series.state, clock.now())).toBeNull();
    expect(series.state.version).toBe(1);
  });

  it('accepts the first price at any size, effective now, with the Market tax flag', () => {
    const { series, set } = setup();
    const outcome = outcomeOf(set(policy.maxUnitPrice.amount));

    expect(outcome.kind).toBe('accepted');
    const record = (outcome as { record: RegularPriceRecord }).record;
    expect(record).toMatchObject({
      status: 'ACCEPTED',
      taxInclusive: fixture.taxInclusive,
      anchor: null,
    });
    expect(record.effectiveFrom?.epochMilliseconds).toBe(clock.now().epochMilliseconds);
    expect(effectiveRegular(series.state, clock.now())?.id).toBe(record.id);
    expect(series.state.version).toBe(2);
  });

  it('accepts a change inside the threshold, closes the previous period and starts it now', () => {
    const { series, set } = setup();
    const first = (outcomeOf(set(fixture.base)) as { record: RegularPriceRecord }).record;
    advance(1000);
    const outcome = outcomeOf(set(fixture.base + 1n));

    expect(outcome.kind).toBe('accepted');
    if (outcome.kind !== 'accepted') return;
    expect(outcome.previous?.id).toBe(first.id);
    expect(outcome.previous?.effectiveTo?.epochMilliseconds).toBe(clock.now().epochMilliseconds);
    expect(effectiveRegular(series.state, clock.now())?.amount.amount).toBe(fixture.base + 1n);
    expect(effectiveRegular(series.state, clock.now().subtract({ milliseconds: 1 }))?.id).toBe(
      first.id,
    );
  });

  it('never starts a record earlier than the previous one plus one millisecond', () => {
    const { set } = setup();
    const first = (outcomeOf(set(fixture.base)) as { record: RegularPriceRecord }).record;
    const second = (outcomeOf(set(fixture.base + 1n)) as { record: RegularPriceRecord }).record;
    const third = (outcomeOf(set(fixture.base + 2n)) as { record: RegularPriceRecord }).record;

    expect(second.effectiveFrom?.epochMilliseconds).toBe(
      (first.effectiveFrom?.epochMilliseconds ?? 0) + 1,
    );
    expect(third.effectiveFrom?.epochMilliseconds).toBe(
      (second.effectiveFrom?.epochMilliseconds ?? 0) + 1,
    );
  });

  it('holds a jump beyond the threshold and leaves the previous price in force', () => {
    const { series, set } = setup();
    const first = (outcomeOf(set(fixture.base)) as { record: RegularPriceRecord }).record;
    advance(1000);
    const outcome = outcomeOf(set(heldUp(fixture.base)));

    expect(outcome.kind).toBe('held');
    if (outcome.kind !== 'held') return;
    expect(outcome.record).toMatchObject({
      status: 'PENDING_REVIEW',
      effectiveFrom: null,
      heldDirection: 'up',
    });
    expect(outcome.record.anchor).toEqual({ recordId: first.id, amount: first.amount });
    expect(effectiveRegular(series.state, clock.now())?.id).toBe(first.id);
  });

  it('holds a drop beyond the threshold only when the policy checks downward moves', () => {
    const { set } = setup();
    set(fixture.base);
    advance(1000);
    const dropped = (fixture.base * (d - n)) / d - 1n;
    const outcome = outcomeOf(set(dropped));
    expect(outcome.kind).toBe(policy.jumpDirections === 'up' ? 'accepted' : 'held');
  });

  it('supersedes a pending record when a new write arrives and measures the new one afresh', () => {
    const { series, set } = setup();
    set(fixture.base);
    advance(1000);
    const held = (outcomeOf(set(heldUp(fixture.base))) as { record: RegularPriceRecord }).record;
    advance(1000);
    const next = outcomeOf(set(fixture.base + 1n));

    expect(next.kind).toBe('accepted');
    expect(next.superseded.map((r) => r.id)).toEqual([held.id]);
    const stored = series.state.regular.find((r) => r.id === held.id);
    expect(stored).toMatchObject({ status: 'SUPERSEDED' });
    expect(stored?.supersededBy).toBe((next as { record: RegularPriceRecord }).record.id);
    expect(series.state.regular.filter((r) => r.status === 'PENDING_REVIEW')).toHaveLength(0);
  });

  it('keeps at most one pending record', () => {
    const { series, set } = setup();
    set(fixture.base);
    advance(1000);
    set(heldUp(fixture.base));
    advance(1000);
    set(heldUp(fixture.base) + 5n);
    expect(series.state.regular.filter((r) => r.status === 'PENDING_REVIEW')).toHaveLength(1);
  });

  it('cancels a pending change when the write equals the price in force, and creates nothing', () => {
    const { series, set } = setup();
    set(fixture.base);
    advance(1000);
    const held = (outcomeOf(set(heldUp(fixture.base))) as { record: RegularPriceRecord }).record;
    advance(1000);
    const before = series.state.regular.length;
    const outcome = outcomeOf(set(fixture.base));

    expect(outcome.kind).toBe('unchanged');
    expect(outcome.superseded.map((r) => r.id)).toEqual([held.id]);
    expect(series.state.regular).toHaveLength(before);
  });

  it('creates nothing and supersedes nothing when equal to the price in force and nothing is pending', () => {
    const { series, set } = setup();
    set(fixture.base);
    advance(1000);
    const outcome = outcomeOf(set(fixture.base));
    expect(outcome).toEqual({ kind: 'unchanged', superseded: [] });
    expect(series.state.regular).toHaveLength(1);
  });

  it('lets the last write of one instant win, even when an earlier one is queued 1 ms ahead', () => {
    const { series, set } = setup();
    set(fixture.base);
    set(fixture.base + 1n);
    const outcome = outcomeOf(set(fixture.base));

    expect(outcome.kind).toBe('accepted');
    advance(5);
    expect(effectiveRegular(series.state, clock.now())?.amount.amount).toBe(fixture.base);
  });

  it('treats a repeat of the latest queued price as unchanged', () => {
    const { series, set } = setup();
    set(fixture.base);
    set(fixture.base + 1n);
    const count = series.state.regular.length;
    expect(outcomeOf(set(fixture.base + 1n)).kind).toBe('unchanged');
    expect(series.state.regular).toHaveLength(count);
  });

  describe('the anchor (pricing design 2.4, option A)', () => {
    it('counts a record that starts exactly at now - W as the record in effect then', () => {
      const { series, set } = setup();
      const first = (outcomeOf(set(fixture.base)) as { record: RegularPriceRecord }).record;
      advance(1000);
      const second = (outcomeOf(set(fixture.base + 1n)) as { record: RegularPriceRecord }).record;
      const edge = second.effectiveFrom as Temporal.Instant;
      const exactly = edge.add({ milliseconds: policy.jumpWindow.milliseconds });
      expect(jumpAnchor(series.state.regular, exactly, policy)?.id).toBe(second.id);
      expect(
        jumpAnchor(series.state.regular, exactly.subtract({ milliseconds: 1 }), policy)?.id,
      ).toBe(first.id);
    });

    it('keeps the window record when the approved record is older than it', () => {
      const { series, set } = setup();
      const windowMs = policy.jumpWindow.milliseconds;
      const first = (outcomeOf(set(fixture.base)) as { record: RegularPriceRecord }).record;
      advance(windowMs / 4);
      const second = (outcomeOf(set(fixture.base + 1n)) as { record: RegularPriceRecord }).record;
      advance(windowMs);
      set(fixture.base + 2n);
      const approvedFirst = series.state.regular.map((r) =>
        r.id === first.id ? { ...r, status: 'APPROVED' as const } : r,
      );
      advance(1000);
      const anchor = jumpAnchor(approvedFirst, clock.now(), policy);
      expect(anchor?.id).toBe(second.id);
    });

    it('catches several small steps whose sum exceeds the threshold inside the window', () => {
      const { set } = setup();
      let price = fixture.base;
      set(price);
      // Each step is well inside T on its own, but the steps add up past it.
      const step = (fixture.base * n) / d / 3n + 1n;
      const kinds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        advance(1000);
        price += step;
        kinds.push(outcomeOf(set(price)).kind);
      }
      expect(kinds).toContain('held');
      expect(kinds[0]).toBe('accepted');
    });

    it('moves the baseline once the window has passed, so a slow drift is accepted', () => {
      const { set } = setup();
      const windowMs = policy.jumpWindow.milliseconds;
      set(fixture.base);
      advance(windowMs / 2);
      set(fixture.base + (fixture.base * n) / d / 2n);
      advance(windowMs);
      // Now the record in effect at now - W is the second one.
      const second = fixture.base + (fixture.base * n) / d / 2n;
      const outcome = outcomeOf(set(second + (second * n) / d / 2n));
      expect(outcome.kind).toBe('accepted');
    });

    it('takes the first record for a series younger than the window', () => {
      const { series, set } = setup();
      const first = (outcomeOf(set(fixture.base)) as { record: RegularPriceRecord }).record;
      advance(1000);
      set(fixture.base + 1n);
      expect(jumpAnchor(series.state.regular, clock.now(), policy)?.id).toBe(first.id);
    });

    it('prefers a later approved record over the window record', () => {
      const { series, set } = setup();
      set(fixture.base);
      advance(1000);
      const second = (outcomeOf(set(fixture.base + 1n)) as { record: RegularPriceRecord }).record;
      const regular = series.state.regular.map((r) =>
        r.id === second.id ? { ...r, status: 'APPROVED' as const } : r,
      );
      advance(1000);
      expect(jumpAnchor(regular, clock.now(), policy)?.id).toBe(second.id);
    });
  });

  describe('retire', () => {
    it('removes the valid price, supersedes a pending record and refuses further writes', () => {
      const { series, set } = setup();
      set(fixture.base);
      advance(1000);
      const held = (outcomeOf(set(heldUp(fixture.base))) as { record: RegularPriceRecord }).record;
      advance(1000);
      const superseded = series.retire('offer-removed', clock.now());

      expect(superseded.map((r) => r.id)).toEqual([held.id]);
      expect(series.state).toMatchObject({ retireCause: 'offer-removed' });
      expect(effectiveRegular(series.state, clock.now())).toBeNull();
      expect(set(fixture.base)).toEqual({ ok: false, error: { code: 'pricing.series-retired' } });
    });

    it('is a no-op the second time', () => {
      const { series } = setup();
      series.retire('variant-removed', clock.now());
      const version = series.state.version;
      expect(series.retire('offer-removed', clock.now())).toEqual([]);
      expect(series.state.retireCause).toBe('variant-removed');
      expect(series.state.version).toBe(version);
    });
  });

  it('never mutates a record it returned earlier', () => {
    const { set } = setup();
    const first = (outcomeOf(set(fixture.base)) as { record: RegularPriceRecord }).record;
    advance(1000);
    set(fixture.base + 1n);
    expect(first.effectiveTo).toBeNull();
    expect(Object.isFrozen(first)).toBe(true);
  });
});
