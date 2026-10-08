import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import {
  SellerTaxProfile,
  type TaxRegistrationInput,
  type TaxRegistrationPeriod,
} from './tax-registration';

// SellerTaxProfile (sellers design 2.1, 2.4 rule 4, 14.4 Q-M13; data design 3.7), on the two
// Market fixtures' shapes: a registration date is turned into an instant in the owning zone.

const SELLER = '01928a3c-0000-7000-8000-000000000001' as Id<'Seller'>;
const ACCOUNT = '01928a3c-0000-7000-8000-0000000000a1' as Id<'Account'>;
const idOf = (n: number) =>
  `01928a3c-0000-7000-8000-00000000f${String(n).padStart(3, '0')}` as Id<'TaxRegistrationPeriod'>;
const NOW = Temporal.Instant.from('2026-10-08T00:00:00Z');
const date = (text: string) => Temporal.PlainDate.from(text);

const FIXTURES = [
  { marketId: 'AU' as MarketId, zone: 'Australia/Brisbane', offsetHours: 10 },
  { marketId: 'ZZ' as MarketId, zone: 'Pacific/Auckland', offsetHours: 13 },
] as const;

describe.each(FIXTURES)('SellerTaxProfile in $marketId (zone $zone)', ({ marketId, zone }) => {
  let counter = 0;
  const newProfile = () =>
    SellerTaxProfile.restore({ sellerId: SELLER, marketId, version: 1, periods: [] });
  const registered = (
    from: string,
    now = NOW,
    overrides: Partial<TaxRegistrationInput> = {},
  ): TaxRegistrationInput => ({
    periodId: idOf((counter += 1)),
    registeredForIndirectTax: true,
    effectiveFromLocal: date(from),
    zone,
    by: { kind: 'seller', accountId: ACCOUNT },
    now,
    ...overrides,
  });
  const notRegistered = (now = NOW): TaxRegistrationInput =>
    registered('2026-01-01', now, { registeredForIndirectTax: false, effectiveFromLocal: null });

  it('records a first registered period at 00:00 of the local date in the owning zone', () => {
    const profile = newProfile();
    const result = profile.record(registered('2026-03-10'));
    expect(result.ok).toBe(true);
    const period = (result as { value: TaxRegistrationPeriod }).value;
    expect(period.validFrom).toEqual(startOf('2026-03-10', zone));
    expect(period.validTo).toBeNull();
    expect(period.effectiveFromLocal.toString()).toBe('2026-03-10');
    expect(period.effectiveZone).toBe(zone);
    expect(period.recordedBy).toEqual({ kind: 'seller', accountId: ACCOUNT });
    expect(profile.version).toBe(2);
    expect(profile.persistedVersion).toBe(1);
    expect(profile.changes.inserted).toEqual([period]);
    expect(profile.changes.validToChanged).toEqual([]);
  });

  it('starts a "not registered" answer at the recording instant, with its local date', () => {
    const profile = newProfile();
    const result = profile.record(notRegistered());
    const period = (result as { value: TaxRegistrationPeriod }).value;
    expect(period.registeredForIndirectTax).toBe(false);
    expect(period.validFrom).toEqual(NOW);
    expect(period.effectiveFromLocal.toString()).toBe(
      NOW.toZonedDateTimeISO(zone).toPlainDate().toString(),
    );
  });

  it('needs a date for "registered" and takes none for "not registered"', () => {
    const profile = newProfile();
    expect(profile.record(registered('2026-03-10', NOW, { effectiveFromLocal: null }))).toEqual({
      ok: false,
      error: { code: 'tax.effective-from-required' },
    });
    expect(
      profile.record(registered('2026-03-10', NOW, { registeredForIndirectTax: false })),
    ).toEqual({ ok: false, error: { code: 'tax.effective-from-unexpected' } });
    expect(profile.version).toBe(1);
    expect(profile.pendingEvents).toEqual([]);
  });

  it('accepts exactly 1970-01-01 and refuses the day before, in the owning zone', () => {
    expect(newProfile().record(registered('1970-01-01')).ok).toBe(true);
    expect(newProfile().record(registered('1969-12-31')).ok).toBe(false);
  });

  it('bounds the future by the local date of the owning zone, not the UTC date', () => {
    // 20:00 UTC on 7 October is already 8 October in both fixture zones.
    const now = Temporal.Instant.from('2026-10-07T20:00:00Z');
    expect(newProfile().record(registered('2027-10-08', now)).ok).toBe(true);
    expect(newProfile().record(registered('2027-10-09', now)).ok).toBe(false);
  });

  it('refuses a date before 1970 or more than a year ahead (typo guard)', () => {
    const profile = newProfile();
    expect(profile.record(registered('1969-12-31')).ok).toBe(false);
    expect(profile.record(registered('2027-10-09')).ok).toBe(false);
    expect(profile.record(registered('2027-10-08')).ok).toBe(true);
  });

  it('closes the open period at the start of the next one, as a chain with no gap', () => {
    const profile = newProfile();
    profile.record(registered('2026-01-01'));
    const first = profile.periods[0]!;
    const second = (
      profile.record(notRegistered(NOW.add({ hours: 1 }))) as {
        value: TaxRegistrationPeriod;
      }
    ).value;
    expect(profile.periods).toHaveLength(2);
    expect(profile.periods[0]!.validTo).toEqual(second.validFrom);
    expect(profile.periods[1]!.validTo).toBeNull();
    expect(profile.changes.inserted.map((p) => p.id)).toEqual([first.id, second.id]);
    // The first was inserted in this same change, so it is written closed: no update needed.
    expect(profile.changes.validToChanged).toEqual([]);
  });

  it('reports a close of a stored period as a valid_to update and writes the new row', () => {
    const stored = newProfile();
    stored.record(registered('2026-01-01'));
    const restored = SellerTaxProfile.restore({
      sellerId: SELLER,
      marketId,
      version: 2,
      periods: stored.periods,
    });
    const next = (
      restored.record(registered('2026-06-01', NOW.add({ hours: 24 }))) as {
        value: TaxRegistrationPeriod;
      }
    ).value;
    expect(restored.changes.validToChanged).toEqual([
      { id: stored.periods[0]!.id, validTo: next.validFrom },
    ]);
    expect(restored.changes.inserted).toEqual([next]);
    expect(restored.version).toBe(3);
  });

  it('refuses a period that does not start after the latest one began, and changes nothing', () => {
    const profile = newProfile();
    profile.record(registered('2026-06-01'));
    const version = profile.version;
    for (const from of ['2026-06-01', '2026-05-31', '2020-01-01']) {
      expect(profile.record(registered(from))).toEqual({
        ok: false,
        error: { code: 'tax.period-overlaps' },
      });
    }
    expect(profile.version).toBe(version);
    expect(profile.periods).toHaveLength(1);
    expect(profile.periods[0]!.validTo).toBeNull();
  });

  it('answers the period in force at an instant (ADR-0007 decision 7)', () => {
    const profile = newProfile();
    profile.record(registered('2026-01-01'));
    profile.record(
      registered('2026-06-01', NOW.add({ hours: 24 }), {
        registeredForIndirectTax: false,
        effectiveFromLocal: null,
      }),
    );
    // Second period starts at its recording instant, 2026-10-09.
    const [a, b] = profile.periods;
    expect(profile.asOf(a!.validFrom.subtract({ milliseconds: 1 }))).toBeNull();
    expect(profile.asOf(a!.validFrom)).toBe(a);
    expect(profile.asOf(b!.validFrom.subtract({ milliseconds: 1 }))).toBe(a);
    expect(profile.asOf(b!.validFrom)).toBe(b);
    expect(profile.asOf(b!.validFrom.add({ hours: 96000 }))).toBe(b);
  });

  it('records one event with the seller id only, per change', () => {
    const profile = newProfile();
    profile.record(registered('2026-01-01'));
    profile.record(notRegistered(NOW.add({ hours: 1 })));
    const events = profile.pendingEvents;
    expect(
      events.map((event) => [event.type, event.aggregateType, event.aggregateVersion]),
    ).toEqual([
      ['sellers.tax-registration-recorded.v1', 'seller-tax-profile', 2],
      ['sellers.tax-registration-recorded.v1', 'seller-tax-profile', 3],
    ]);
    expect(events[0]!.aggregateId).toBe(SELLER);
    expect(events[0]!.payload).toEqual({ sellerId: SELLER });
  });

  describe('cancel (Q-M13)', () => {
    const withFuture = () => {
      const stored = newProfile();
      stored.record(registered('2026-01-01'));
      stored.record(registered('2027-02-01', NOW.add({ minutes: 1 })));
      return SellerTaxProfile.restore({
        sellerId: SELLER,
        marketId,
        version: 3,
        periods: stored.periods,
      });
    };

    it('deletes a period that has not started and re-opens the one it had closed', () => {
      const profile = withFuture();
      const [first, future] = profile.periods;
      expect(profile.cancel(future!.id, NOW.add({ hours: 48 }))).toEqual({
        ok: true,
        value: undefined,
      });
      expect(profile.periods).toHaveLength(1);
      expect(profile.periods[0]!.validTo).toBeNull();
      expect(profile.changes.deleted).toEqual([future!.id]);
      expect(profile.changes.validToChanged).toEqual([{ id: first!.id, validTo: null }]);
      expect(profile.version).toBe(4);
      expect(profile.pendingEvents).toHaveLength(1);
    });

    it('re-opens the previous period only up to the next remaining one (three periods)', () => {
      const stored = newProfile();
      stored.record(registered('2026-01-01'));
      stored.record(registered('2027-02-01', NOW.add({ minutes: 1 })));
      stored.record(registered('2027-06-01', NOW.add({ minutes: 2 })));
      const profile = SellerTaxProfile.restore({
        sellerId: SELLER,
        marketId,
        version: 4,
        periods: stored.periods,
      });
      const [a, b, c] = profile.periods;
      expect(profile.cancel(b!.id, NOW.add({ hours: 48 })).ok).toBe(true);
      expect(profile.periods.map((p) => p.id)).toEqual([a!.id, c!.id]);
      expect(profile.periods[0]!.validTo).toEqual(c!.validFrom);
      expect(profile.periods[1]!.validTo).toBeNull();
      expect(profile.changes.validToChanged).toEqual([{ id: a!.id, validTo: c!.validFrom }]);
      // No overlap: the chain restores.
      expect(() =>
        SellerTaxProfile.restore({
          sellerId: SELLER,
          marketId,
          version: 5,
          periods: profile.periods,
        }),
      ).not.toThrow();
    });

    it('refuses a period that has started, and an unknown one', () => {
      const profile = withFuture();
      const [first, future] = profile.periods;
      expect(profile.cancel(first!.id, NOW)).toEqual({
        ok: false,
        error: { code: 'tax.period-started' },
      });
      expect(profile.cancel(future!.id, future!.validFrom)).toEqual({
        ok: false,
        error: { code: 'tax.period-started' },
      });
      expect(profile.cancel(idOf(999), NOW)).toEqual({
        ok: false,
        error: { code: 'tax.period-not-found' },
      });
      expect(profile.version).toBe(3);
      expect(profile.periods).toHaveLength(2);
    });

    it('writes nothing for a period recorded and cancelled in the same change', () => {
      const profile = newProfile();
      const future = (profile.record(registered('2027-02-01')) as { value: TaxRegistrationPeriod })
        .value;
      profile.cancel(future.id, NOW);
      expect(profile.changes).toEqual({ deleted: [], validToChanged: [], inserted: [] });
      expect(profile.periods).toEqual([]);
    });
  });

  it('refuses to restore stored periods that overlap or are empty', () => {
    const base = newProfile();
    base.record(registered('2026-01-01'));
    const period = base.periods[0]!;
    expect(() =>
      SellerTaxProfile.restore({
        sellerId: SELLER,
        marketId,
        version: 2,
        periods: [
          period,
          { ...period, id: idOf(500), validFrom: period.validFrom.add({ hours: 24 }) },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      SellerTaxProfile.restore({
        sellerId: SELLER,
        marketId,
        version: 2,
        periods: [{ ...period, validTo: period.validFrom }],
      }),
    ).toThrow(RangeError);
  });
});

describe('SellerTaxProfile in a zone that skips midnight', () => {
  // Cuba starts daylight saving at 00:00 on 2026-03-08, so that local day begins at 01:00.
  const zone = 'America/Havana';
  it('starts a registered period at the first instant of the local day', () => {
    const profile = SellerTaxProfile.restore({
      sellerId: SELLER,
      marketId: 'AU' as MarketId,
      version: 1,
      periods: [],
    });
    const result = profile.record({
      periodId: idOf(900),
      registeredForIndirectTax: true,
      effectiveFromLocal: date('2026-03-08'),
      zone,
      by: { kind: 'admin', accountId: ACCOUNT },
      now: NOW,
    });
    const period = (result as { value: TaxRegistrationPeriod }).value;
    expect(period.validFrom).toEqual(Temporal.Instant.from('2026-03-08T05:00:00Z'));
    expect(period.validFrom.toZonedDateTimeISO(zone).toPlainDate().toString()).toBe('2026-03-08');
  });
});

function startOf(dateText: string, zone: string): Temporal.Instant {
  return Temporal.PlainDate.from(dateText).toZonedDateTime({ timeZone: zone }).toInstant();
}
