import { Temporal } from '@mondapac/shared-kernel';
import type { TimeZoneId } from './claim-types';
import { expiryBoundary } from './validity';
import {
  productExpiryActionAt,
  productReinstateRefusal,
  productRevocationRefusal,
  productSuspensionRefusal,
  suspensionReason,
  type ProductExpiryFacts,
} from './product-certification-lifecycle';
import type { ReviewPolicy } from './review';

// The pure rules of a manufacturer certificate after approval (certification design 3.4 rows 6 to
// 9, 8.6; ADR-0012 d3; slice 15): suspend, revoke, reinstate by another person, and the expiry
// job's decision in the Market zone on the stored boundary. Every case that depends on a zone runs
// on AU and ZZ.

const MARKETS = [
  { code: 'AU', zone: 'Australia/Brisbane' as TimeZoneId },
  { code: 'ZZ', zone: 'Asia/Tokyo' as TimeZoneId },
] as const;

const policy: ReviewPolicy = {
  checks: [],
  reasons: [
    { code: 'forged', check: null, nextStep: 'x', label: 'x', outcomes: ['declined', 'revoked'] },
    { code: 'being-checked', check: null, nextStep: 'x', label: 'x', outcomes: ['suspended'] },
  ],
  issuerRequestReasons: [],
};

describe('suspend and revoke (design 3.4 rows 6 and 8)', () => {
  it('suspends only an approved record with an approved revision', () => {
    expect(productSuspensionRefusal({ status: 'approved', hasApproval: true })).toBeNull();
    expect(productSuspensionRefusal({ status: 'suspended', hasApproval: true })).toEqual({
      code: 'certificate.suspended',
    });
    for (const status of ['revoked', 'rejected'] as const) {
      expect(productSuspensionRefusal({ status, hasApproval: true })).toEqual({
        code: 'certificate.closed',
      });
    }
    for (const status of ['draft', 'in-review', 'expired'] as const) {
      expect(productSuspensionRefusal({ status, hasApproval: status === 'expired' })).toEqual({
        code: 'certificate.not-suspendable',
      });
    }
    expect(productSuspensionRefusal({ status: 'approved', hasApproval: false })).toEqual({
      code: 'certificate.not-suspendable',
    });
  });

  it('revokes an approved or suspended record; revoked is terminal and named', () => {
    expect(productRevocationRefusal({ status: 'approved', hasApproval: true })).toBeNull();
    expect(productRevocationRefusal({ status: 'suspended', hasApproval: true })).toBeNull();
    expect(productRevocationRefusal({ status: 'revoked', hasApproval: true })).toEqual({
      code: 'certificate.revoked',
    });
    for (const status of ['draft', 'in-review', 'rejected', 'expired'] as const) {
      expect(productRevocationRefusal({ status, hasApproval: status === 'expired' })).toEqual({
        code: 'certificate.not-revocable',
      });
    }
  });

  it('takes a suspension reason only from the Market list for the suspended outcome', () => {
    expect(suspensionReason(policy, 'being-checked')).toMatchObject({
      ok: true,
      value: { code: 'being-checked' },
    });
    expect(suspensionReason(policy, 'forged')).toEqual({ ok: false, code: 'unknown' });
    expect(suspensionReason(policy, undefined)).toEqual({ ok: false, code: 'required' });
    expect(suspensionReason(policy, '')).toEqual({ ok: false, code: 'required' });
  });
});

describe.each(MARKETS)(
  'reinstate by another person in market $code (design 3.4 row 7)',
  ({ zone }) => {
    const now = Temporal.Instant.from('2027-01-01T00:00:00Z');
    const expiryDate = Temporal.PlainDate.from('2027-06-30');
    const stored = expiryBoundary(expiryDate, zone);
    const base = {
      actorAccountId: 'reviewer',
      authorAccountId: 'creator',
      editorAccountIds: ['editor', 'submitter'],
      status: 'suspended' as const,
      hasApproval: true,
      issuer: { state: 'active' as const, typeMatches: true },
      requiresExpiry: true,
      expiryDate,
      storedBoundary: stored,
      marketZone: zone,
      now,
    };

    it('allows another person on a suspended record whose issuer still counts and boundary is ahead', () => {
      expect(productReinstateRefusal(base)).toBeNull();
      expect(
        productReinstateRefusal({ ...base, issuer: { state: 'closed-to-new', typeMatches: true } }),
      ).toBeNull();
    });

    it('refuses the creator and every editor of the approved revision', () => {
      for (const actorAccountId of ['creator', 'editor', 'submitter']) {
        expect(productReinstateRefusal({ ...base, actorAccountId })).toEqual({
          code: 'approval.same-admin',
        });
      }
    });

    it('refuses a record that is not suspended, a derecognised issuer and a passed boundary', () => {
      expect(productReinstateRefusal({ ...base, status: 'approved' })).toEqual({
        code: 'certificate.not-suspended',
      });
      expect(productReinstateRefusal({ ...base, status: 'revoked' })).toEqual({
        code: 'certificate.closed',
      });
      expect(productReinstateRefusal({ ...base, hasApproval: false })).toEqual({
        code: 'certificate.not-suspended',
      });
      expect(
        productReinstateRefusal({ ...base, issuer: { state: 'derecognised', typeMatches: true } }),
      ).toEqual({ code: 'issuer.not-active' });
      expect(productReinstateRefusal({ ...base, issuer: null })).toEqual({
        code: 'issuer.not-active',
      });
      expect(productReinstateRefusal({ ...base, now: stored })).toEqual({
        code: 'certificate.expired',
      });
    });

    it('fails closed without a usable Market zone when an expiry is required, and ignores it otherwise', () => {
      expect(productReinstateRefusal({ ...base, marketZone: null })).toEqual({
        code: 'certificate.expired',
      });
      expect(
        productReinstateRefusal({
          ...base,
          requiresExpiry: false,
          marketZone: null,
          now: stored.add({ hours: 1 }),
        }),
      ).toBeNull();
    });
  },
);

describe.each(MARKETS)('expiry job decision in market $code (design 8.6)', ({ zone }) => {
  const expiryDate = Temporal.PlainDate.from('2027-06-30');
  const stored = expiryBoundary(expiryDate, zone);
  const facts: ProductExpiryFacts = {
    status: 'approved',
    requiresExpiry: true,
    expiryDate,
    storedBoundary: stored,
    boundaryZone: zone,
    warnedThresholds: [],
  };
  const thresholds = [30, 14, 1];

  it('expires exactly at the stored boundary, when evaluateClaim stops granting', () => {
    expect(productExpiryActionAt(facts, zone, thresholds, stored.subtract({ seconds: 1 }))).toEqual(
      { kind: 'warn', thresholdDays: 1, boundary: stored },
    );
    expect(productExpiryActionAt(facts, zone, thresholds, stored)).toEqual({
      kind: 'expire',
      boundary: stored,
    });
  });

  it('takes the earlier of the stored boundary and the boundary in the current Market zone', () => {
    // The Market zone moved east after approval: the claim ends earlier, so does the job.
    const east = 'Pacific/Kiritimati' as TimeZoneId;
    const earlier = expiryBoundary(expiryDate, east);
    expect(Temporal.Instant.compare(earlier, stored)).toBeLessThan(0);
    expect(productExpiryActionAt(facts, east, thresholds, earlier)).toEqual({
      kind: 'expire',
      boundary: earlier,
    });
    // Moved west: the stored boundary still decides.
    const west = 'Pacific/Pago_Pago' as TimeZoneId;
    expect(productExpiryActionAt(facts, west, thresholds, stored)).toEqual({
      kind: 'expire',
      boundary: stored,
    });
    // No usable current zone: the stored boundary alone.
    expect(productExpiryActionAt(facts, null, thresholds, stored)).toEqual({
      kind: 'expire',
      boundary: stored,
    });
  });

  it('warns from 00:00 Market time of the day T days before the boundary day, once per threshold', () => {
    const day30 = Temporal.PlainDate.from('2027-06-01').toZonedDateTime(zone).toInstant();
    expect(productExpiryActionAt(facts, zone, thresholds, day30.subtract({ seconds: 1 }))).toEqual({
      kind: 'none',
    });
    expect(productExpiryActionAt(facts, zone, thresholds, day30)).toEqual({
      kind: 'warn',
      thresholdDays: 30,
      boundary: stored,
    });
    expect(
      productExpiryActionAt({ ...facts, warnedThresholds: [30] }, zone, thresholds, day30),
    ).toEqual({ kind: 'none' });
    // Approved close to expiry: only the most urgent due threshold.
    const day1 = Temporal.PlainDate.from('2027-06-30').toZonedDateTime(zone).toInstant();
    expect(productExpiryActionAt(facts, zone, thresholds, day1)).toEqual({
      kind: 'warn',
      thresholdDays: 1,
      boundary: stored,
    });
  });

  it('does nothing for a record that is not approved, a type without expiry, or no boundary', () => {
    for (const status of ['suspended', 'revoked', 'expired', 'in-review'] as const) {
      expect(productExpiryActionAt({ ...facts, status }, zone, thresholds, stored)).toEqual({
        kind: 'none',
      });
    }
    expect(
      productExpiryActionAt({ ...facts, requiresExpiry: false }, zone, thresholds, stored),
    ).toEqual({ kind: 'none' });
    expect(
      productExpiryActionAt({ ...facts, storedBoundary: null }, zone, thresholds, stored),
    ).toEqual({ kind: 'none' });
    expect(productExpiryActionAt({ ...facts, expiryDate: null }, zone, thresholds, stored)).toEqual(
      { kind: 'none' },
    );
  });
});
