import { Temporal } from '@mondapac/shared-kernel';
import { money } from '@mondapac/shared-kernel';
import { SequenceIdGenerator } from '@mondapac/shared-kernel/testing';
import { priceAmount } from './price-amount';
import { createPricingPolicy } from './pricing-policy';
import {
  InvalidPriceSeriesStateError,
  PriceSeries as PriceSeriesAggregate,
  effectiveRegular,
  jumpAnchor,
} from './price-series';
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
      supersedeCause: null,
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
      const exactly = edge.add({ milliseconds: policy.jumpWindowMs });
      expect(jumpAnchor(series.state.regular, exactly, policy)?.id).toBe(second.id);
      expect(
        jumpAnchor(series.state.regular, exactly.subtract({ milliseconds: 1 }), policy)?.id,
      ).toBe(first.id);
    });

    it('keeps the window record when the approved record is older than it', () => {
      const { series, set } = setup();
      const windowMs = policy.jumpWindowMs;
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
      const windowMs = policy.jumpWindowMs;
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

  describe('the domain re-checks what the caller built (Hassan M1)', () => {
    it('refuses an amount in another currency, even one that equals the price in force', () => {
      const { series, set } = setup();
      set(fixture.base);
      const other = PRICING_FIXTURES.find(
        (f) => f.code !== fixture.code,
      ) as (typeof PRICING_FIXTURES)[number];
      const foreign = amountOf(other, fixture.base);
      const result = series.setRegularPrice({
        recordId: ids.next<'RegularPriceRecord'>(),
        amount: foreign,
        submittedBy: account,
        taxInclusive: fixture.taxInclusive,
        now: clock.now(),
        policy,
      });
      expect(result).toEqual({ ok: false, error: { code: 'pricing.currency-mismatch' } });
      expect(series.state.regular).toHaveLength(1);
    });

    it("refuses an amount above this policy's maximum", () => {
      const { series } = setup();
      const wide = createPricingPolicy({
        marketId: policy.marketId,
        currency: policy.currency,
        maxUnitPriceMinor: policy.maxUnitPrice.amount * 10n,
        thresholdNumerator: policy.thresholdNumerator,
        thresholdDenominator: policy.thresholdDenominator,
        jumpDirections: policy.jumpDirections,
        jumpWindow: 'P3D',
      });
      const tooBig = priceAmount(money(policy.maxUnitPrice.amount + 1n, policy.currency), wide);
      if (!tooBig.ok) throw new Error('fixture');
      expect(
        series.setRegularPrice({
          recordId: ids.next<'RegularPriceRecord'>(),
          amount: tooBig.value,
          submittedBy: account,
          taxInclusive: fixture.taxInclusive,
          now: clock.now(),
          policy,
        }),
      ).toEqual({ ok: false, error: { code: 'pricing.amount-out-of-range' } });
    });

    it('refuses a policy of another Market', () => {
      const { series } = setup();
      const other = PRICING_FIXTURES.find(
        (f) => f.code !== fixture.code,
      ) as (typeof PRICING_FIXTURES)[number];
      expect(
        series.setRegularPrice({
          recordId: ids.next<'RegularPriceRecord'>(),
          amount: amountOf(other, 1000n),
          submittedBy: account,
          taxInclusive: fixture.taxInclusive,
          now: clock.now(),
          policy: other.policy,
        }),
      ).toEqual({ ok: false, error: { code: 'pricing.policy-market-mismatch' } });
    });
  });

  describe('what persistence needs (slice 1, part 2; pricing-data 3.2, 3.3)', () => {
    it('records the series currency at creation (pricing-data P2)', () => {
      const { series } = setup();
      expect(series.state.currency).toBe(policy.currency);
    });

    it('refuses an amount in another currency than the series, even under a policy that allows it', () => {
      const { series, set } = setup();
      set(fixture.base);
      const otherCurrency = policy.currency === 'JPY' ? 'AUD' : 'JPY';
      const drifted = createPricingPolicy({
        marketId: policy.marketId,
        currency: otherCurrency,
        maxUnitPriceMinor: policy.maxUnitPrice.amount,
        thresholdNumerator: policy.thresholdNumerator,
        thresholdDenominator: policy.thresholdDenominator,
        jumpDirections: policy.jumpDirections,
        jumpWindow: 'P3D',
      });
      const amount = priceAmount(money(fixture.base + 1n, otherCurrency), drifted);
      if (!amount.ok) throw new Error('fixture');
      expect(
        series.setRegularPrice({
          recordId: ids.next<'RegularPriceRecord'>(),
          amount: amount.value,
          submittedBy: account,
          taxInclusive: fixture.taxInclusive,
          now: clock.now(),
          policy: drifted,
        }),
      ).toEqual({ ok: false, error: { code: 'pricing.currency-mismatch' } });
      expect(series.state.regular).toHaveLength(1);
    });

    it('stores the anchor on an accepted record that was measured, and none on the first price', () => {
      const { set } = setup();
      const first = (outcomeOf(set(fixture.base)) as { record: RegularPriceRecord }).record;
      advance(1000);
      const second = (outcomeOf(set(fixture.base + 1n)) as { record: RegularPriceRecord }).record;

      expect(first.anchor).toBeNull();
      expect(second).toMatchObject({ status: 'ACCEPTED', heldDirection: null });
      expect(second.anchor).toEqual({ recordId: first.id, amount: first.amount });
    });

    it('names the cause of every supersede: replaced, cancelled, or the retirement cause', () => {
      const { series, set } = setup();
      set(fixture.base);
      advance(1000);
      const replaced = (outcomeOf(set(heldUp(fixture.base))) as { record: RegularPriceRecord })
        .record;
      advance(1000);
      const replacing = (
        outcomeOf(set(heldUp(fixture.base) + 1n)) as { record: RegularPriceRecord }
      ).record;
      advance(1000);
      set(fixture.base);
      advance(1000);
      const retired = (outcomeOf(set(heldUp(fixture.base))) as { record: RegularPriceRecord })
        .record;
      series.retire('variant-removed', clock.now());
      const byId = (id: string) => series.state.regular.find((r) => r.id === id);

      expect(byId(replaced.id)).toMatchObject({
        status: 'SUPERSEDED',
        supersedeCause: 'replaced',
        supersededBy: replacing.id,
      });
      expect(byId(replacing.id)).toMatchObject({ supersedeCause: 'cancelled', supersededBy: null });
      expect(byId(retired.id)).toMatchObject({
        supersedeCause: 'variant-removed',
        supersededBy: null,
      });
      expect(series.state.regular.filter((r) => r.status !== 'SUPERSEDED')).toEqual(
        series.state.regular.filter((r) => r.supersedeCause === null),
      );
    });

    it('remembers the stored state: none for a new series, the restored one, then what was stored', () => {
      const { series, set } = setup();
      expect(series.persistedVersion).toBeNull();
      expect(series.storedState).toBeNull();

      series.markStored();
      expect(series.persistedVersion).toBe(1);
      set(fixture.base);
      expect(series.persistedVersion).toBe(1);
      expect(series.storedState?.regular).toEqual([]);

      const restored = PriceSeriesAggregate.restore(series.state);
      expect(restored.persistedVersion).toBe(2);
      expect(restored.storedState).toBe(restored.state);
    });
  });

  describe('restore', () => {
    it('refuses a record in another currency than the series', () => {
      const { series, set } = setup();
      set(fixture.base);
      const otherCurrency = policy.currency === 'JPY' ? 'AUD' : 'JPY';
      const regular = series.state.regular.map((r) => ({
        ...r,
        amount: { ...r.amount, currency: otherCurrency },
      })) as unknown as RegularPriceRecord[];
      expect(() => PriceSeriesAggregate.restore({ ...series.state, regular })).toThrow(
        InvalidPriceSeriesStateError,
      );
    });

    it('refuses a superseded record without its cause, or a replaced one without its successor', () => {
      const { series, set } = setup();
      set(fixture.base);
      advance(1000);
      set(heldUp(fixture.base));
      advance(1000);
      set(fixture.base + 1n);
      const corrupt = (change: Partial<RegularPriceRecord>) =>
        series.state.regular.map((r) => (r.status === 'SUPERSEDED' ? { ...r, ...change } : r));
      expect(() =>
        PriceSeriesAggregate.restore({
          ...series.state,
          regular: corrupt({ supersedeCause: null }),
        }),
      ).toThrow(InvalidPriceSeriesStateError);
      expect(() =>
        PriceSeriesAggregate.restore({ ...series.state, regular: corrupt({ supersededBy: null }) }),
      ).toThrow(InvalidPriceSeriesStateError);
    });

    it('rebuilds a series with frozen records and no shared references', () => {
      const { series, set } = setup();
      set(fixture.base);
      advance(1000);
      set(heldUp(fixture.base));
      const restored = PriceSeriesAggregate.restore({
        ...series.state,
        regular: [...series.state.regular],
      });
      for (const record of restored.state.regular) {
        expect(Object.isFrozen(record)).toBe(true);
        expect(Object.isFrozen(record.amount)).toBe(true);
      }
      expect(restored.state.regular.map((r) => r.id)).toEqual(
        series.state.regular.map((r) => r.id),
      );
    });

    it.each([
      [
        'two pending records',
        (r: RegularPriceRecord[]) => [
          ...r,
          { ...(r[1] as RegularPriceRecord), id: ids.next<'RegularPriceRecord'>() },
        ],
      ],
      [
        'a pending record with an effective start',
        (r: RegularPriceRecord[]) =>
          r.map((x) =>
            x.status === 'PENDING_REVIEW' ? { ...x, effectiveFrom: x.submittedAt } : x,
          ),
      ],
      [
        'a gap between priced records',
        (r: RegularPriceRecord[]) => r.map((x, i) => (i === 0 ? { ...x, effectiveTo: null } : x)),
      ],
    ])('refuses %s', (_name, corrupt) => {
      const { series, set } = setup();
      set(fixture.base);
      advance(1000);
      set(fixture.base + 1n);
      advance(1000);
      set(heldUp(fixture.base + 1n));
      const regular = corrupt([...series.state.regular]);
      expect(() => PriceSeriesAggregate.restore({ ...series.state, regular })).toThrow(
        InvalidPriceSeriesStateError,
      );
    });

    it('does not leak the creation instant into the state', () => {
      const { series } = setup();
      expect(Object.keys(series.state)).not.toContain('now');
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
