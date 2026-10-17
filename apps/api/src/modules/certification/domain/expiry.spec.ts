import { Temporal } from '@mondapac/shared-kernel';
import type { TimeZoneId } from './claim-types';
import {
  assertExpiryPolicy,
  candidateHorizon,
  ExpiryPolicyError,
  expiryActionAt,
  jobBoundary,
  renewalSubmitBy,
  type ExpiryFacts,
} from './expiry';
import { expiryBoundary, sellerCertificateValidAt } from './validity';

// The expiry and warning decision of the job (certification design 3.1, 8.6; AC 8, AC 9), pure:
// the boundary in the seller's local time, the earliest of the stored one and the current zones,
// one warning per threshold on the seller's local day, nothing for a type without expiry. Run on
// the AU zones of AC 8 (Brisbane, Perth, Sydney, Adelaide) and on the synthetic Market's zone.

const z = (s: string): TimeZoneId => s as TimeZoneId;
const BRISBANE = z('Australia/Brisbane');
const PERTH = z('Australia/Perth');
const SYDNEY = z('Australia/Sydney');
const ADELAIDE = z('Australia/Adelaide');
const ZZ_ZONE = z('Pacific/Auckland');
const at = (s: string): Temporal.Instant => Temporal.Instant.from(s);
const THRESHOLDS = [30, 14, 1] as const;

function facts(zone: TimeZoneId, over: Partial<ExpiryFacts> = {}): ExpiryFacts {
  const expiryDate =
    over.expiryDate === undefined ? Temporal.PlainDate.from('2027-03-31') : over.expiryDate;
  return {
    status: 'approved',
    requiresExpiry: true,
    expiryDate,
    zoneAtApproval: zone,
    storedBoundary: expiryDate === null ? null : expiryBoundary(expiryDate, zone),
    warnedThresholds: [],
    ...over,
  };
}
const same = (zone: TimeZoneId) => ({ zone, addressZone: zone });

describe('jobBoundary and expiryActionAt (AC 8, AC 9)', () => {
  it.each([
    ['Brisbane', BRISBANE],
    ['Perth', PERTH],
    ['ZZ zone', ZZ_ZONE],
  ])('expires at 00:00 of the day after the expiry date in %s, not at 23:59', (_name, zone) => {
    const boundary = Temporal.PlainDate.from('2027-04-01').toZonedDateTime(zone).toInstant();
    const before = boundary.subtract({ minutes: 1 });
    expect(expiryActionAt(facts(zone), same(zone), THRESHOLDS, before).kind).not.toBe('expire');
    expect(expiryActionAt(facts(zone), same(zone), THRESHOLDS, boundary)).toEqual({
      kind: 'expire',
      boundary,
    });
  });

  it('expires the Brisbane seller while the Perth seller is still valid at the same instant', () => {
    // Brisbane +10 ends at 2027-03-31T14:00Z; Perth +8 at 16:00Z.
    const now = at('2027-03-31T15:00:00Z');
    expect(expiryActionAt(facts(BRISBANE), same(BRISBANE), THRESHOLDS, now).kind).toBe('expire');
    expect(expiryActionAt(facts(PERTH), same(PERTH), THRESHOLDS, now).kind).not.toBe('expire');
  });

  it.each([
    // Sydney and Adelaide leave daylight saving on 2027-04-04 (03:00 local back to 02:00).
    ['Sydney', SYDNEY, '2027-04-03', at('2027-04-03T13:00:00Z')],
    ['Adelaide', ADELAIDE, '2027-04-03', at('2027-04-03T13:30:00Z')],
    // And enter it on 2026-10-04: the day after 2026-10-03 starts at 00:00 standard time.
    ['Sydney (spring)', SYDNEY, '2026-10-03', at('2026-10-03T14:00:00Z')],
    ['Adelaide (spring)', ADELAIDE, '2026-10-03', at('2026-10-03T14:30:00Z')],
  ])('is DST-safe in %s', (_name, zone, date, boundary) => {
    const f = facts(zone, { expiryDate: Temporal.PlainDate.from(date) });
    expect(jobBoundary(f, same(zone))).toEqual({ at: boundary, zone });
    expect(
      expiryActionAt(f, same(zone), THRESHOLDS, boundary.subtract({ seconds: 1 })).kind,
    ).not.toBe('expire');
    expect(expiryActionAt(f, same(zone), THRESHOLDS, boundary).kind).toBe('expire');
  });

  it('takes the earliest of the stored boundary, the chosen zone and the address zone (never later than the claim)', () => {
    // Approved in Perth (16:00Z); the seller now chose Brisbane (14:00Z); address Perth.
    const f = facts(PERTH);
    expect(jobBoundary(f, { zone: BRISBANE, addressZone: PERTH })).toEqual({
      at: at('2027-03-31T14:00:00Z'),
      zone: BRISBANE,
    });
    // Approved in Brisbane; the seller moved to Perth: the stored Brisbane boundary still decides.
    expect(jobBoundary(facts(BRISBANE), same(PERTH))).toEqual({
      at: at('2027-03-31T14:00:00Z'),
      zone: BRISBANE,
    });
  });

  it('expires exactly when evaluateClaim stops granting, for every zone pair', () => {
    const zones = [BRISBANE, PERTH, SYDNEY, ADELAIDE, ZZ_ZONE];
    for (const approval of zones) {
      for (const chosen of zones) {
        for (const address of zones) {
          const f = facts(approval);
          const boundary = jobBoundary(f, { zone: chosen, addressZone: address })!.at;
          const view = {
            certificateId: 'c' as never,
            status: 'approved' as const,
            approved: {
              submissionId: 's' as never,
              typeRevisionId: 'r' as never,
              verificationMode: 'THIRD_PARTY_DOCUMENT' as const,
              requiresExpiry: true,
              expiryDate: f.expiryDate,
              zoneAtApproval: approval,
              issuerId: null,
              issuerState: null,
              issuerDisplayName: null,
              verifiedWithIssuer: false,
            },
          };
          const pair = { zone: chosen, addressZone: address };
          expect(
            sellerCertificateValidAt(view, pair, boundary.subtract({ nanoseconds: 1 })).valid,
          ).toBe(true);
          expect(sellerCertificateValidAt(view, pair, boundary).valid).toBe(false);
        }
      }
    }
  });

  it('recomputes the approval-zone boundary as the claim does, not the stored instant (Hassan I1)', () => {
    // A stored instant an hour later (tzdata changed since approval) does not delay the job.
    const f = facts(BRISBANE, { storedBoundary: at('2027-03-31T15:00:00Z') });
    expect(jobBoundary(f, null)).toEqual({ at: at('2027-03-31T14:00:00Z'), zone: BRISBANE });
    // Without a usable approval zone the stored instant is all there is.
    const g = facts(BRISBANE, { zoneAtApproval: null });
    expect(jobBoundary(g, null)).toEqual({ at: at('2027-03-31T14:00:00Z'), zone: null });
  });

  it('uses only the approval boundary when the seller has no usable approved zones (never earlier)', () => {
    const f = facts(BRISBANE);
    for (const zones of [
      null,
      { zone: null, addressZone: null },
      { zone: '+10:00', addressZone: 'Mars/Base' },
    ]) {
      expect(jobBoundary(f, zones)).toEqual({ at: at('2027-03-31T14:00:00Z'), zone: BRISBANE });
      expect(expiryActionAt(f, zones, THRESHOLDS, at('2027-03-31T13:59:59Z')).kind).not.toBe(
        'expire',
      );
      expect(expiryActionAt(f, zones, THRESHOLDS, at('2027-03-31T14:00:00Z')).kind).toBe('expire');
    }
  });

  it('does nothing for a type without expiry, a record that is not approved or a missing date', () => {
    const late = at('2099-01-01T00:00:00Z');
    expect(
      expiryActionAt(facts(BRISBANE, { requiresExpiry: false }), same(BRISBANE), THRESHOLDS, late),
    ).toEqual({ kind: 'none' });
    for (const status of [
      'expired',
      'revoked',
      'in-review',
      'declined',
      'draft',
      'changes-needed',
    ] as const) {
      expect(expiryActionAt(facts(BRISBANE, { status }), same(BRISBANE), THRESHOLDS, late)).toEqual(
        {
          kind: 'none',
        },
      );
    }
    expect(
      expiryActionAt(
        facts(BRISBANE, { expiryDate: null, storedBoundary: null }),
        same(BRISBANE),
        THRESHOLDS,
        late,
      ),
    ).toEqual({ kind: 'none' });
  });
});

describe('warnings on the seller local day (AC 9, CERT-14)', () => {
  // Expiry date 2027-03-31; the boundary is the start of 2027-04-01. The 30-day warning is due
  // from the start of 2027-03-02 local, the 14-day from 2027-03-18, the 1-day from 2027-03-31.
  it.each([
    ['Brisbane', BRISBANE, 30, '2027-03-02'],
    ['Brisbane', BRISBANE, 14, '2027-03-18'],
    ['Brisbane', BRISBANE, 1, '2027-03-31'],
    ['Perth', PERTH, 14, '2027-03-18'],
    ['Sydney', SYDNEY, 30, '2027-03-02'],
    ['ZZ zone', ZZ_ZONE, 1, '2027-03-31'],
  ])('%s: the %d-day warning starts at 00:00 local on %s', (_n, zone, days, day) => {
    const start = Temporal.PlainDate.from(day).toZonedDateTime(zone).toInstant();
    const warned = THRESHOLDS.filter((t) => t > days);
    const f = facts(zone, { warnedThresholds: warned });
    // One second before, this threshold is not due (and the larger ones are already sent).
    expect(expiryActionAt(f, same(zone), THRESHOLDS, start.subtract({ seconds: 1 }))).toEqual({
      kind: 'none',
    });
    expect(expiryActionAt(f, same(zone), THRESHOLDS, start)).toMatchObject({
      kind: 'warn',
      thresholdDays: days,
    });
  });

  it('warns the Brisbane seller a day earlier in UTC terms than the Perth seller is not yet due', () => {
    // 2027-03-30T15:00Z is 01:00 on 31 March in Brisbane and 23:00 on 30 March in Perth.
    const now = at('2027-03-30T15:00:00Z');
    const warned = [30, 14];
    expect(
      expiryActionAt(
        facts(BRISBANE, { warnedThresholds: warned }),
        same(BRISBANE),
        THRESHOLDS,
        now,
      ),
    ).toMatchObject({ kind: 'warn', thresholdDays: 1 });
    expect(
      expiryActionAt(facts(PERTH, { warnedThresholds: warned }), same(PERTH), THRESHOLDS, now),
    ).toEqual({ kind: 'none' });
  });

  it('sends each threshold once: a stored marker makes the decision none', () => {
    const now = at('2027-03-20T00:00:00Z');
    expect(
      expiryActionAt(
        facts(BRISBANE, { warnedThresholds: [30, 14] }),
        same(BRISBANE),
        THRESHOLDS,
        now,
      ),
    ).toEqual({
      kind: 'none',
    });
  });

  it('sends only the most urgent due threshold when several fall due at once', () => {
    // Approved 10 days before expiry: 30 and 14 are both due, only 14 is sent and 30 never is.
    const now = at('2027-03-21T00:00:00Z');
    expect(expiryActionAt(facts(BRISBANE), same(BRISBANE), THRESHOLDS, now)).toMatchObject({
      kind: 'warn',
      thresholdDays: 14,
    });
    expect(
      expiryActionAt(facts(BRISBANE, { warnedThresholds: [14] }), same(BRISBANE), THRESHOLDS, now),
    ).toEqual({ kind: 'none' });
  });

  it('never warns past the boundary: the record expires instead', () => {
    expect(
      expiryActionAt(facts(BRISBANE), same(BRISBANE), THRESHOLDS, at('2027-04-02T00:00:00Z')),
    ).toEqual({
      kind: 'expire',
      boundary: at('2027-03-31T14:00:00Z'),
    });
  });
});

describe('the policy and the selection horizon', () => {
  it('reaches back 26 hours plus the largest threshold', () => {
    expect(candidateHorizon(at('2027-01-01T00:00:00Z'), [30, 14, 1]).toString()).toBe(
      '2027-02-01T02:00:00Z',
    );
    expect(candidateHorizon(at('2027-01-01T00:00:00Z'), []).toString()).toBe(
      '2027-01-02T02:00:00Z',
    );
  });

  it('refuses a malformed policy', () => {
    expect(() =>
      assertExpiryPolicy({ warningThresholdsDays: [30, 14, 1], renewalSubmitByDays: 7 }, 'AU'),
    ).not.toThrow();
    for (const bad of [
      { warningThresholdsDays: [30, 30], renewalSubmitByDays: 7 },
      { warningThresholdsDays: [0], renewalSubmitByDays: 7 },
      { warningThresholdsDays: [400], renewalSubmitByDays: 7 },
      { warningThresholdsDays: [1.5], renewalSubmitByDays: 7 },
      { warningThresholdsDays: [30], renewalSubmitByDays: -1 },
    ]) {
      expect(() => assertExpiryPolicy(bad, 'X')).toThrow(ExpiryPolicyError);
    }
  });

  it('gives the renewal submit-by date as a local date', () => {
    expect(renewalSubmitBy(Temporal.PlainDate.from('2027-03-31'), 7).toString()).toBe('2027-03-24');
    expect(renewalSubmitBy(Temporal.PlainDate.from('2027-03-01'), 2).toString()).toBe('2027-02-27');
  });
});
