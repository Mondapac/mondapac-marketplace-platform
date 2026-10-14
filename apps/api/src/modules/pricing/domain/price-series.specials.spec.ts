import { Temporal } from '@mondapac/shared-kernel';
import { SequenceIdGenerator } from '@mondapac/shared-kernel/testing';
import { effectivePriceAt, PriceSeries, specialChanges } from './price-series';
import type { RegularPriceRecord } from './price-series';
import type { SpecialPriceRecord } from './special-price';
import {
  PRICING_FIXTURES,
  amountOf,
  newClock,
  newSeries,
} from '../../../../test/support/pricing-fixtures';

// Special prices of a series (pricing design 3.2, 4.1, 4.3, Q2, Q3), on both Market fixtures.
// The AU fixture holds a discount of more than half; the synthetic ZZ fixture holds upward jumps
// only, so no special is ever held there.
describe.each(PRICING_FIXTURES)('PriceSeries special prices in market $code', (fixture) => {
  const { policy } = fixture;
  const clock = newClock();
  const ids = new SequenceIdGenerator(clock);
  const seller = ids.next<'Account'>();
  const at = (iso: string) => Temporal.Instant.from(iso);
  const advance = (ms: number) => clock.set(clock.now().add({ milliseconds: ms }));
  const HOUR = 3_600_000;
  const ms = (instant: Temporal.Instant | null) => instant?.epochMilliseconds;

  beforeEach(() => clock.set(at('2026-10-08T10:00:00Z')));

  const setRegular = (series: PriceSeries, minor: bigint): RegularPriceRecord => {
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

  /** A series with a regular price of `base` in force. */
  function priced(): PriceSeries {
    const series = newSeries(fixture, clock, ids);
    setRegular(series, fixture.base);
    advance(1000);
    return series;
  }

  const setSpecial = (
    series: PriceSeries,
    minor: bigint,
    window: { startsAt?: Temporal.Instant | null; endsAt: Temporal.Instant },
    submittedBy = seller,
  ) =>
    series.setSpecialPrice({
      recordId: ids.next<'SpecialPriceRecord'>(),
      amount: amountOf(fixture, minor),
      submittedBy,
      taxInclusive: fixture.taxInclusive,
      startsAt: window.startsAt ?? null,
      endsAt: window.endsAt,
      now: clock.now(),
      policy,
    });

  const accepted = (
    series: PriceSeries,
    minor: bigint,
    window: { startsAt?: Temporal.Instant | null; endsAt: Temporal.Instant },
  ): SpecialPriceRecord => {
    const result = setSpecial(series, minor, window);
    if (!result.ok || result.value.kind !== 'accepted') throw new Error('setup: not accepted');
    return result.value.record;
  };

  const inHours = (hours: number) => clock.now().add({ milliseconds: hours * HOUR });
  const discounted = (percent: bigint) => (fixture.base * (100n - percent)) / 100n;

  describe('setSpecialPrice', () => {
    it('accepts a special below the regular price: effective from its start, and the buyer pays it', () => {
      const series = priced();
      const before = series.state.version;
      const result = setSpecial(series, discounted(10n), { endsAt: inHours(24) });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({ kind: 'accepted', withdrawn: null, superseded: [] });
      const record = result.value.record;
      expect(record).toMatchObject({
        status: 'ACCEPTED',
        heldDirection: null,
        withdrawnAt: null,
        decision: null,
      });
      expect(ms(record.effectiveFrom)).toBe(clock.now().epochMilliseconds);
      expect(ms(record.startsAt)).toBe(clock.now().epochMilliseconds);
      expect(series.state.version).toBe(before + 1);
      expect(series.pendingEvents.at(-1)).toMatchObject({
        type: 'pricing.effective-price-changed.v1',
        aggregateVersion: before + 1,
        payload: { cause: 'special-started' },
      });

      const effective = effectivePriceAt(series.state, clock.now());
      expect(effective).toMatchObject({ basis: 'special', recordId: record.id });
      expect(effective?.amount.amount).toBe(discounted(10n));
      expect(ms(effective?.specialEndsAt ?? null)).toBe(ms(inHours(24)));
    });

    it('copies the regular price and the anchor it was written against', () => {
      const series = priced();
      const regular = series.state.regular[0] as RegularPriceRecord;
      const record = accepted(series, discounted(10n), { endsAt: inHours(24) });
      expect(record.regular).toEqual({ recordId: regular.id, amount: regular.amount });
      expect(record.anchor.recordId).toBe(regular.id);
    });

    it('keeps a scheduled special out of the price until it starts, and ends it at its end', () => {
      const series = priced();
      const startsAt = inHours(2);
      const endsAt = inHours(5);
      const record = accepted(series, discounted(20n), { startsAt, endsAt });
      expect(ms(record.effectiveFrom)).toBe(ms(startsAt));

      const regularOnly = effectivePriceAt(series.state, clock.now());
      expect(regularOnly).toMatchObject({ basis: 'regular', specialEndsAt: null });
      expect(effectivePriceAt(series.state, startsAt)).toMatchObject({ basis: 'special' });
      expect(effectivePriceAt(series.state, endsAt.subtract({ milliseconds: 1 }))).toMatchObject({
        basis: 'special',
      });
      // Half-open: the end instant is already the regular price. Nothing stored, nothing run.
      expect(effectivePriceAt(series.state, endsAt)).toMatchObject({ basis: 'regular' });
    });

    it('refuses without a regular price, at or above it, a start in the past and a bad window', () => {
      const fresh = newSeries(fixture, clock, ids);
      expect(setSpecial(fresh, 1n, { endsAt: inHours(1) })).toEqual({
        ok: false,
        error: { code: 'pricing.no-regular-price' },
      });

      const series = priced();
      const codes = (minor: bigint, window: Parameters<typeof setSpecial>[2]) => {
        const result = setSpecial(series, minor, window);
        return result.ok ? 'ok' : result.error.code;
      };
      expect(codes(fixture.base, { endsAt: inHours(1) })).toBe('pricing.special-not-below-regular');
      expect(codes(fixture.base + 1n, { endsAt: inHours(1) })).toBe(
        'pricing.special-not-below-regular',
      );
      expect(
        codes(discounted(10n), {
          startsAt: clock.now().subtract({ milliseconds: 1 }),
          endsAt: inHours(1),
        }),
      ).toBe('pricing.special-window.start-in-past');
      expect(codes(discounted(10n), { startsAt: inHours(2), endsAt: inHours(2) })).toBe(
        'pricing.special-window.invalid',
      );
      expect(codes(discounted(10n), { endsAt: clock.now() })).toBe(
        'pricing.special-window.invalid',
      );
      // Nothing was recorded by the refusals.
      expect(series.state.specials).toEqual([]);
    });

    it('refuses another currency, an amount out of range and a retired series', () => {
      const series = priced();
      const wrong = series.setSpecialPrice({
        recordId: ids.next<'SpecialPriceRecord'>(),
        amount: { ...amountOf(fixture, discounted(10n)), currency: 'XXX' },
        submittedBy: seller,
        taxInclusive: fixture.taxInclusive,
        startsAt: null,
        endsAt: inHours(1),
        now: clock.now(),
        policy,
      });
      expect(wrong.ok ? 'ok' : wrong.error.code).toBe('pricing.currency-mismatch');

      const over = series.setSpecialPrice({
        recordId: ids.next<'SpecialPriceRecord'>(),
        amount: { ...amountOf(fixture, 1n), amount: policy.maxUnitPrice.amount + 1n },
        submittedBy: seller,
        taxInclusive: fixture.taxInclusive,
        startsAt: null,
        endsAt: inHours(1),
        now: clock.now(),
        policy,
      });
      expect(over.ok ? 'ok' : over.error.code).toBe('pricing.amount-out-of-range');

      series.retire('offer-removed', clock.now());
      expect(setSpecial(series, discounted(10n), { endsAt: inHours(1) })).toEqual({
        ok: false,
        error: { code: 'pricing.series-retired' },
      });
    });

    it('replaces the running special: the old one ends now, the new one takes over', () => {
      const series = priced();
      const first = accepted(series, discounted(10n), { endsAt: inHours(24) });
      advance(HOUR);
      const result = setSpecial(series, discounted(20n), { endsAt: inHours(10) });
      if (!result.ok) throw new Error('setup');

      expect(result.value.withdrawn?.id).toBe(first.id);
      const old = series.state.specials.find((r) => r.id === first.id) as SpecialPriceRecord;
      expect(old).toMatchObject({ status: 'WITHDRAWN', withdrawCause: 'replaced' });
      expect(ms(old.withdrawnAt)).toBe(clock.now().epochMilliseconds);
      const effective = effectivePriceAt(series.state, clock.now());
      expect(effective).toMatchObject({ basis: 'special', recordId: result.value.record.id });
      // Before the replacement the old special was the price.
      expect(
        effectivePriceAt(series.state, clock.now().subtract({ milliseconds: 1 })),
      ).toMatchObject({ basis: 'special', recordId: first.id });
    });

    it('replaces a scheduled special too, and an ended one is left alone', () => {
      const series = priced();
      const ended = accepted(series, discounted(10n), { endsAt: inHours(1) });
      advance(2 * HOUR);
      const scheduled = accepted(series, discounted(15n), {
        startsAt: inHours(5),
        endsAt: inHours(9),
      });
      const result = setSpecial(series, discounted(20n), { endsAt: inHours(3) });
      if (!result.ok) throw new Error('setup');

      expect(result.value.withdrawn?.id).toBe(scheduled.id);
      expect(series.state.specials.find((r) => r.id === ended.id)?.status).toBe('ACCEPTED');
      expect(effectivePriceAt(series.state, inHours(6))).toMatchObject({ basis: 'regular' });
      expect(effectivePriceAt(series.state, clock.now())).toMatchObject({ basis: 'special' });
    });
  });

  describe('Q2: a regular price stays above a running or scheduled special', () => {
    it('refuses a regular price at or below the special, and allows one above it', () => {
      const series = priced();
      const special = accepted(series, discounted(10n), { endsAt: inHours(24) });
      advance(1000);
      const attempt = (minor: bigint) =>
        series.setRegularPrice({
          recordId: ids.next<'RegularPriceRecord'>(),
          amount: amountOf(fixture, minor),
          submittedBy: seller,
          taxInclusive: fixture.taxInclusive,
          now: clock.now(),
          policy,
        });
      const version = series.state.version;
      for (const minor of [special.amount.amount, special.amount.amount - 1n]) {
        expect(attempt(minor)).toEqual({
          ok: false,
          error: { code: 'pricing.regular-not-above-special' },
        });
      }
      expect(series.state.version).toBe(version);
      expect(attempt(special.amount.amount + 1n).ok).toBe(true);
    });

    it('allows a lower regular price once the special has ended or been withdrawn', () => {
      const series = priced();
      accepted(series, discounted(10n), { endsAt: inHours(1) });
      advance(2 * HOUR);
      const result = series.setRegularPrice({
        recordId: ids.next<'RegularPriceRecord'>(),
        amount: amountOf(fixture, discounted(20n)),
        submittedBy: seller,
        taxInclusive: fixture.taxInclusive,
        now: clock.now(),
        policy,
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('withdrawSpecialPrice', () => {
    it('ends the running special now and the regular price is the price again', () => {
      const series = priced();
      const special = accepted(series, discounted(10n), { endsAt: inHours(24) });
      advance(HOUR);
      const before = series.state.version;
      const result = series.withdrawSpecialPrice(clock.now());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.withdrawn?.id).toBe(special.id);
      expect(result.value.cancelled).toBeNull();
      expect(series.state.specials[0]).toMatchObject({
        status: 'WITHDRAWN',
        withdrawCause: 'withdrawn',
      });
      expect(effectivePriceAt(series.state, clock.now())).toMatchObject({ basis: 'regular' });
      expect(series.state.version).toBe(before + 1);
      expect(series.pendingEvents.at(-1)).toMatchObject({
        payload: { cause: 'special-withdrawn' },
      });
    });

    it('withdraws a scheduled special before it starts: it never takes effect', () => {
      const series = priced();
      accepted(series, discounted(10n), { startsAt: inHours(3), endsAt: inHours(6) });
      const result = series.withdrawSpecialPrice(clock.now());
      expect(result.ok).toBe(true);
      expect(effectivePriceAt(series.state, inHours(4))).toMatchObject({ basis: 'regular' });
    });

    it('answers not-found when there is nothing to end, and refuses a retired series', () => {
      const series = priced();
      expect(series.withdrawSpecialPrice(clock.now())).toEqual({
        ok: false,
        error: { code: 'pricing.special-price.not-found' },
      });
      accepted(series, discounted(10n), { endsAt: inHours(1) });
      advance(2 * HOUR);
      expect(series.withdrawSpecialPrice(clock.now())).toEqual({
        ok: false,
        error: { code: 'pricing.special-price.not-found' },
      });
      series.retire('variant-removed', clock.now());
      expect(series.withdrawSpecialPrice(clock.now())).toEqual({
        ok: false,
        error: { code: 'pricing.series-retired' },
      });
    });
  });

  describe('retire', () => {
    it('withdraws the running special and supersedes the pending one, by the system', () => {
      const series = priced();
      const special = accepted(series, discounted(10n), { endsAt: inHours(24) });
      advance(1000);
      series.retire('offer-removed', clock.now());

      expect(series.state.specials[0]).toMatchObject({
        id: special.id,
        status: 'WITHDRAWN',
        withdrawCause: 'offer-removed',
      });
      expect(effectivePriceAt(series.state, clock.now())).toBeNull();
      const changes = specialChanges(series);
      expect(changes.withdrawn.map((r) => r.id)).toEqual([special.id]);
      expect(changes.superseded).toEqual([]);
      expect(series.pendingEvents.at(-1)).toMatchObject({ payload: { cause: 'series-retired' } });
    });
  });

  it('restores every state the methods produce', () => {
    const series = priced();
    accepted(series, discounted(10n), { endsAt: inHours(5) });
    advance(HOUR);
    accepted(series, discounted(20n), { startsAt: inHours(2), endsAt: inHours(8) });
    advance(HOUR);
    setSpecial(series, discounted(30n), { endsAt: inHours(3) });
    series.withdrawSpecialPrice(clock.now());
    expect(() => PriceSeries.restore(series.state)).not.toThrow();
  });
});

// The Market that holds discounts (AU: both directions, threshold 1/2).
describe('PriceSeries special price discount hold (market AU)', () => {
  const fixture = PRICING_FIXTURES[0]!;
  const { policy } = fixture;
  const clock = newClock();
  const ids = new SequenceIdGenerator(clock);
  const seller = ids.next<'Account'>();
  const admin = ids.next<'Account'>();
  const HOUR = 3_600_000;
  const advance = (ms: number) => clock.set(clock.now().add({ milliseconds: ms }));
  const inHours = (hours: number) => clock.now().add({ milliseconds: hours * HOUR });

  beforeEach(() => clock.set(Temporal.Instant.from('2026-10-08T10:00:00Z')));

  const setRegular = (series: PriceSeries, minor: bigint) => {
    const result = series.setRegularPrice({
      recordId: ids.next<'RegularPriceRecord'>(),
      amount: amountOf(fixture, minor),
      submittedBy: seller,
      taxInclusive: true,
      now: clock.now(),
      policy,
    });
    if (!result.ok || result.value.kind === 'unchanged') throw new Error('setup');
    return result.value.record;
  };
  const setSpecial = (
    series: PriceSeries,
    minor: bigint,
    endsAt: Temporal.Instant,
    startsAt?: Temporal.Instant,
  ) =>
    series.setSpecialPrice({
      recordId: ids.next<'SpecialPriceRecord'>(),
      amount: amountOf(fixture, minor),
      submittedBy: seller,
      taxInclusive: true,
      startsAt: startsAt ?? null,
      endsAt,
      now: clock.now(),
      policy,
    });
  const held = (
    series: PriceSeries,
    minor: bigint,
    endsAt = inHours(10),
    startsAt?: Temporal.Instant,
  ) => {
    const result = setSpecial(series, minor, endsAt, startsAt);
    if (!result.ok || result.value.kind !== 'held') throw new Error('setup: not held');
    return result.value.record;
  };
  const priced = () => {
    const series = newSeries(fixture, clock, ids);
    setRegular(series, 10000n);
    advance(1000);
    return series;
  };
  const approve = (series: PriceSeries, id: SpecialPriceRecord['id'], by = admin) =>
    series.approveSpecialHold({ recordId: id, decidedBy: by, now: clock.now(), policy });

  it('holds a discount of more than the threshold and keeps the current special', () => {
    const series = priced();
    const current = setSpecial(series, 9000n, inHours(24));
    if (!current.ok) throw new Error('setup');
    const before = series.state.version;
    const record = held(series, 4000n);

    expect(record).toMatchObject({
      status: 'PENDING_REVIEW',
      heldDirection: 'down',
      effectiveFrom: null,
    });
    expect(series.state.version).toBe(before + 1);
    expect(series.pendingEvents.at(-1)).toMatchObject({
      type: 'pricing.price-hold-opened.v1',
      payload: { kind: 'special', direction: 'down', recordId: record.id },
    });
    // The running special is still the price; the held one is not.
    expect(effectivePriceAt(series.state, clock.now())).toMatchObject({
      basis: 'special',
      recordId: current.value.record.id,
    });
  });

  it('measures a special against the regular jump anchor as well (Hassan finding 1)', () => {
    const series = newSeries(fixture, clock, ids);
    setRegular(series, 10000n);
    advance(1000);
    setRegular(series, 8000n);
    advance(1000);
    // 4500 is more than half below the anchor of 10000 but not below half of the regular 8000.
    const record = held(series, 4500n);
    expect(record.regular.amount.amount).toBe(8000n);
    expect(record.anchor.amount.amount).toBe(10000n);
    expect(accepted(series, 4500n).ok).toBe(false);
  });

  function accepted(series: PriceSeries, minor: bigint) {
    const result = setSpecial(series, minor, inHours(5));
    return { ok: result.ok && result.value.kind === 'accepted' };
  }

  it('supersedes a pending special that a new write replaces', () => {
    const series = priced();
    const first = held(series, 4000n);
    advance(1000);
    const result = setSpecial(series, 3000n, inHours(10));
    if (!result.ok) throw new Error('setup');
    expect(result.value.superseded.map((r) => r.id)).toEqual([first.id]);
    expect(series.state.specials.find((r) => r.id === first.id)).toMatchObject({
      status: 'SUPERSEDED',
      supersedeCause: 'replaced',
      supersededBy: result.value.record.id,
    });
    expect(series.state.specials.filter((r) => r.status === 'PENDING_REVIEW')).toHaveLength(1);
  });

  describe('approveSpecialHold', () => {
    it('is effective from approval, replaces the running special and records the decision', () => {
      const series = priced();
      const running = setSpecial(series, 9000n, inHours(24));
      if (!running.ok) throw new Error('setup');
      const record = held(series, 4000n, inHours(24));
      advance(HOUR);
      const before = series.state.version;
      const result = approve(series, record.id);

      expect(result.ok).toBe(true);
      const approved = series.state.specials.find((r) => r.id === record.id) as SpecialPriceRecord;
      expect(approved).toMatchObject({ status: 'APPROVED', withdrawnAt: null });
      expect(approved.effectiveFrom?.epochMilliseconds).toBe(clock.now().epochMilliseconds);
      expect(approved.decision).toMatchObject({ decidedBy: admin, reasonCode: null, note: null });
      expect(series.state.specials.find((r) => r.id === running.value.record.id)).toMatchObject({
        status: 'WITHDRAWN',
        withdrawCause: 'replaced',
      });
      expect(series.state.version).toBe(before + 2);
      expect(series.pendingEvents.slice(-2).map((e) => [e.type, e.payload])).toEqual([
        [
          'pricing.price-hold-decided.v1',
          expect.objectContaining({ kind: 'special', outcome: 'approved' }),
        ],
        [
          'pricing.effective-price-changed.v1',
          expect.objectContaining({ cause: 'special-started' }),
        ],
      ]);
      expect(effectivePriceAt(series.state, clock.now())).toMatchObject({
        basis: 'special',
        recordId: record.id,
      });
    });

    it('keeps the requested start when it is still ahead', () => {
      const series = priced();
      const record = held(series, 4000n, inHours(10), inHours(5));
      advance(HOUR);
      expect(approve(series, record.id).ok).toBe(true);
      const approved = series.state.specials[0] as SpecialPriceRecord;
      expect(approved.effectiveFrom?.epochMilliseconds).toBe(record.startsAt.epochMilliseconds);
    });

    it('refuses the submitter, a decided record, an unknown id and a retired series', () => {
      const series = priced();
      const record = held(series, 4000n);
      expect(approve(series, record.id, seller)).toEqual({
        ok: false,
        error: { code: 'pricing.hold.own-submission' },
      });
      expect(approve(series, ids.next<'SpecialPriceRecord'>())).toEqual({
        ok: false,
        error: { code: 'pricing.hold.not-found' },
      });
      expect(approve(series, record.id).ok).toBe(true);
      expect(approve(series, record.id)).toEqual({
        ok: false,
        error: { code: 'pricing.hold.not-pending' },
      });
      const other = priced();
      const pending = held(other, 4000n);
      other.retire('offer-removed', clock.now());
      expect(approve(other, pending.id)).toEqual({
        ok: false,
        error: { code: 'pricing.series-retired' },
      });
    });

    it('refuses a special whose window ended while it waited, and one no longer below the regular price', () => {
      const series = priced();
      const late = held(series, 4000n, inHours(2));
      advance(3 * HOUR);
      expect(approve(series, late.id)).toEqual({
        ok: false,
        error: { code: 'pricing.special-window.ended' },
      });

      const raised = priced();
      const record = held(raised, 4000n);
      advance(1000);
      // The regular price itself drops to the special's level (held, then approved by an admin).
      const lower = setRegular(raised, 4000n);
      expect(lower.status).toBe('PENDING_REVIEW');
      advance(1000);
      expect(
        raised.approveHold({ recordId: lower.id, decidedBy: admin, now: clock.now(), policy }).ok,
      ).toBe(true);
      expect(approve(raised, record.id)).toEqual({
        ok: false,
        error: { code: 'pricing.special-not-below-regular' },
      });
      expect(raised.state.specials[0]?.status).toBe('PENDING_REVIEW');
    });
  });

  describe('rejectSpecialHold', () => {
    it('rejects with a reason and leaves the current special alone', () => {
      const series = priced();
      const running = setSpecial(series, 9000n, inHours(24));
      if (!running.ok) throw new Error('setup');
      const record = held(series, 4000n);
      advance(1000);
      const result = series.rejectSpecialHold({
        recordId: record.id,
        decidedBy: admin,
        reasonCode: 'price-implausible',
        note: 'Looks like a typo',
        now: clock.now(),
      });
      expect(result.ok).toBe(true);
      expect(series.state.specials.find((r) => r.id === record.id)).toMatchObject({
        status: 'REJECTED',
        decision: { decidedBy: admin, reasonCode: 'price-implausible', note: 'Looks like a typo' },
      });
      expect(effectivePriceAt(series.state, clock.now())).toMatchObject({
        recordId: running.value.record.id,
      });
      expect(series.pendingEvents.at(-1)).toMatchObject({
        payload: { kind: 'special', outcome: 'rejected' },
      });
    });

    it('refuses the submitter', () => {
      const series = priced();
      const record = held(series, 4000n);
      expect(
        series.rejectSpecialHold({
          recordId: record.id,
          decidedBy: seller,
          reasonCode: 'other',
          note: null,
          now: clock.now(),
        }),
      ).toEqual({ ok: false, error: { code: 'pricing.hold.own-submission' } });
    });
  });

  it('Q2 at approval: a held regular price at or below a running special stays pending', () => {
    const series = priced();
    const lower = setRegular(series, 4000n); // a drop of more than half: held
    expect(lower.status).toBe('PENDING_REVIEW');
    advance(1000);
    const special = setSpecial(series, 6000n, inHours(24));
    expect(special.ok && special.value.kind).toBe('accepted');
    advance(1000);
    expect(
      series.approveHold({ recordId: lower.id, decidedBy: admin, now: clock.now(), policy }),
    ).toEqual({ ok: false, error: { code: 'pricing.regular-not-above-special' } });
    expect(series.state.regular.find((r) => r.id === lower.id)?.status).toBe('PENDING_REVIEW');
  });

  it('retires a pending special with the series', () => {
    const series = priced();
    const record = held(series, 4000n);
    advance(1000);
    series.retire('variant-removed', clock.now());
    expect(series.state.specials.find((r) => r.id === record.id)).toMatchObject({
      status: 'SUPERSEDED',
      supersedeCause: 'variant-removed',
    });
    expect(specialChanges(series).superseded.map((r) => r.id)).toEqual([record.id]);
    expect(series.pendingEvents.slice(-2).map((e) => e.payload)).toEqual([
      expect.objectContaining({ kind: 'special', outcome: 'superseded' }),
      expect.objectContaining({ cause: 'series-retired' }),
    ]);
  });
});
