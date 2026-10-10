import { Temporal } from '@mondapac/shared-kernel';
import { SequenceIdGenerator } from '@mondapac/shared-kernel/testing';
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

// The decisions on a held price (pricing design 3.1 rows 3 and 4), on both Market fixtures.
describe.each(PRICING_FIXTURES)('PriceSeries hold decisions in market $code', (fixture) => {
  const { policy } = fixture;
  const n = policy.thresholdNumerator;
  const d = policy.thresholdDenominator;
  const clock = newClock();
  const ids = new SequenceIdGenerator(clock);
  const seller = ids.next<'Account'>();
  const admin = ids.next<'Account'>();
  const heldUp = (base: bigint): bigint => (base * (d + n)) / d + 1n;
  const advance = (ms: number) => clock.set(clock.now().add({ milliseconds: ms }));

  beforeEach(() => clock.set(Temporal.Instant.from('2026-10-08T10:00:00Z')));

  /** A series with a price in force and one held record. */
  function withHold(): { series: PriceSeries; first: RegularPriceRecord; held: RegularPriceRecord } {
    const series = newSeries(fixture, clock, ids);
    const set = (minor: bigint): RegularPriceRecord => {
      const result = series.setRegularPrice({
        recordId: ids.next<'RegularPriceRecord'>(),
        amount: amountOf(fixture, minor),
        submittedBy: seller,
        taxInclusive: fixture.taxInclusive,
        now: clock.now(),
        policy,
      });
      if (!result.ok || result.value.kind === 'unchanged') throw new Error('setup');
      return result.value.record;
    };
    const first = set(fixture.base);
    advance(1000);
    const held = set(heldUp(fixture.base));
    expect(held.status).toBe('PENDING_REVIEW');
    return { series, first, held };
  }

  const approve = (series: PriceSeries, recordId: RegularPriceRecord['id'], by = admin) =>
    series.approveHold({ recordId, decidedBy: by, now: clock.now(), policy });

  it('approves: effective from approval, closes the previous period, becomes the anchor', () => {
    const { series, first, held } = withHold();
    advance(60_000);
    const before = series.state.version;
    const result = approve(series, held.id);

    expect(result.ok).toBe(true);
    const approved = series.state.regular.find((r) => r.id === held.id) as RegularPriceRecord;
    expect(approved).toMatchObject({ status: 'APPROVED', effectiveTo: null });
    expect(approved.effectiveFrom?.epochMilliseconds).toBe(clock.now().epochMilliseconds);
    expect(approved.decision).toMatchObject({ decidedBy: admin, reasonCode: null, note: null });
    expect(approved.decision?.decidedAt.epochMilliseconds).toBe(clock.now().epochMilliseconds);
    const previous = series.state.regular.find((r) => r.id === first.id) as RegularPriceRecord;
    expect(previous.effectiveTo?.epochMilliseconds).toBe(clock.now().epochMilliseconds);
    expect(effectiveRegular(series.state, clock.now())?.id).toBe(held.id);
    expect(jumpAnchor(series.state.regular, clock.now(), policy)?.id).toBe(held.id);

    expect(series.state.version).toBe(before + 2);
    expect(series.pendingEvents.slice(-2).map((e) => [e.type, e.aggregateVersion, e.payload])).toEqual(
      [
        [
          'pricing.price-hold-decided.v1',
          before + 1,
          expect.objectContaining({ recordId: held.id, kind: 'regular', outcome: 'approved' }),
        ],
        [
          'pricing.effective-price-changed.v1',
          before + 2,
          expect.objectContaining({ cause: 'hold-approved' }),
        ],
      ],
    );
    // Restorable: the stored shape satisfies every invariant.
    expect(() => PriceSeriesAggregate.restore(series.state)).not.toThrow();
  });

  it('starts one millisecond after the previous start when approved in the same millisecond', () => {
    const series = newSeries(fixture, clock, ids);
    const set = (minor: bigint) =>
      series.setRegularPrice({
        recordId: ids.next<'RegularPriceRecord'>(),
        amount: amountOf(fixture, minor),
        submittedBy: seller,
        taxInclusive: fixture.taxInclusive,
        now: clock.now(),
        policy,
      });
    set(fixture.base);
    const held = set(heldUp(fixture.base));
    if (!held.ok || held.value.kind !== 'held') throw new Error('setup');
    // The price in force started now; approving at the same instant starts +1 ms.
    expect(approve(series, held.value.record.id).ok).toBe(true);
    const record = series.state.regular.find((r) => r.status === 'APPROVED') as RegularPriceRecord;
    expect(record.effectiveFrom?.epochMilliseconds).toBe(clock.now().epochMilliseconds + 1);
  });

  it('refuses the submitting account (H4) and changes nothing', () => {
    const { series, held } = withHold();
    const before = series.state;
    const result = approve(series, held.id, seller);
    expect(result).toEqual({ ok: false, error: { code: 'pricing.hold.own-submission' } });
    expect(
      series.rejectHold({
        recordId: held.id,
        decidedBy: seller,
        reasonCode: 'other',
        note: null,
        now: clock.now(),
      }),
    ).toEqual({ ok: false, error: { code: 'pricing.hold.own-submission' } });
    expect(series.state).toBe(before);
    expect(series.pendingEvents.some((e) => e.payload['outcome'] === 'approved')).toBe(false);
  });

  it('refuses an unknown, a decided and a superseded record', () => {
    const { series, first, held } = withHold();
    expect(approve(series, ids.next<'RegularPriceRecord'>())).toEqual({
      ok: false,
      error: { code: 'pricing.hold.not-found' },
    });
    expect(approve(series, first.id)).toEqual({
      ok: false,
      error: { code: 'pricing.hold.not-pending' },
    });
    advance(10);
    expect(approve(series, held.id).ok).toBe(true);
    expect(approve(series, held.id)).toEqual({
      ok: false,
      error: { code: 'pricing.hold.not-pending' },
    });
  });

  it('refuses a record superseded by a newer write', () => {
    const { series, held } = withHold();
    advance(10);
    series.setRegularPrice({
      recordId: ids.next<'RegularPriceRecord'>(),
      amount: amountOf(fixture, fixture.base + 1n),
      submittedBy: seller,
      taxInclusive: fixture.taxInclusive,
      now: clock.now(),
      policy,
    });
    expect(approve(series, held.id)).toEqual({
      ok: false,
      error: { code: 'pricing.hold.not-pending' },
    });
  });

  it('refuses a retired series', () => {
    const { series, held } = withHold();
    series.retire('offer-removed', clock.now());
    expect(approve(series, held.id)).toEqual({
      ok: false,
      error: { code: 'pricing.series-retired' },
    });
  });

  it('re-checks the limits under the current policy at approval, not the one of the write', () => {
    const { series, held } = withHold();
    const stricter = createPricingPolicy({
      marketId: policy.marketId,
      currency: policy.currency,
      maxUnitPriceMinor: held.amount.amount - 1n,
      thresholdNumerator: n,
      thresholdDenominator: d,
      jumpDirections: policy.jumpDirections,
      jumpWindow: 'P3D',
    });
    const before = series.state;
    expect(
      series.approveHold({ recordId: held.id, decidedBy: admin, now: clock.now(), policy: stricter }),
    ).toEqual({ ok: false, error: { code: 'pricing.amount-out-of-range' } });
    expect(series.state).toBe(before);
    // The admin can still reject it.
    expect(
      series.rejectHold({
        recordId: held.id,
        decidedBy: admin,
        reasonCode: 'policy-breach',
        note: null,
        now: clock.now(),
      }).ok,
    ).toBe(true);
  });

  it("refuses another Market's policy", () => {
    const { series, held } = withHold();
    const other = PRICING_FIXTURES.find((f) => f.code !== fixture.code)!.policy;
    expect(
      series.approveHold({ recordId: held.id, decidedBy: admin, now: clock.now(), policy: other }),
    ).toEqual({ ok: false, error: { code: 'pricing.policy-market-mismatch' } });
  });

  it('rejects with a reason and a note, leaves the previous price, one event', () => {
    const { series, first, held } = withHold();
    advance(500);
    const before = series.state.version;
    const result = series.rejectHold({
      recordId: held.id,
      decidedBy: admin,
      reasonCode: 'price-implausible',
      note: 'looks like a typo',
      now: clock.now(),
    });
    expect(result.ok).toBe(true);
    const rejected = series.state.regular.find((r) => r.id === held.id) as RegularPriceRecord;
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      effectiveFrom: null,
      decision: { decidedBy: admin, reasonCode: 'price-implausible', note: 'looks like a typo' },
    });
    expect(effectiveRegular(series.state, clock.now())?.id).toBe(first.id);
    expect(series.state.version).toBe(before + 1);
    const last = series.pendingEvents[series.pendingEvents.length - 1]!;
    expect(last.type).toBe('pricing.price-hold-decided.v1');
    expect(last.payload).toMatchObject({ recordId: held.id, outcome: 'rejected' });
    expect(JSON.stringify(last.payload)).not.toContain('typo');
    expect(() => PriceSeriesAggregate.restore(series.state)).not.toThrow();
  });

  it('refuses to restore a decided record without a decision or decided by its submitter', () => {
    const { series, held } = withHold();
    advance(10);
    approve(series, held.id);
    const corrupt = (decision: RegularPriceRecord['decision']) => ({
      ...series.state,
      regular: series.state.regular.map((r) => (r.id === held.id ? { ...r, decision } : r)),
    });
    expect(() => PriceSeriesAggregate.restore(corrupt(null))).toThrow(InvalidPriceSeriesStateError);
    expect(() =>
      PriceSeriesAggregate.restore(
        corrupt({ decidedAt: clock.now(), decidedBy: seller, reasonCode: null, note: null }),
      ),
    ).toThrow(InvalidPriceSeriesStateError);
  });
});
