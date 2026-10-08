import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import type { TimeZoneId } from './claim-types';
import { expiryBoundary, sellerCertificateValidAt } from './validity';
import type { SellerCertificationView } from './validity';

const z = (s: string): TimeZoneId => s as TimeZoneId;
const BRISBANE = z('Australia/Brisbane');
const SYDNEY = z('Australia/Sydney');
// ZZ: the synthetic Market's zone, far from AU (CLAUDE.md: two market fixtures).
const ZZ = z('Pacific/Auckland');

const cert = (
  over: Partial<NonNullable<SellerCertificationView['approved']>> = {},
  status: SellerCertificationView['status'] = 'approved',
): SellerCertificationView => ({
  certificateId: 'c1' as Id,
  status,
  approved: {
    submissionId: 's1' as Id,
    typeRevisionId: 'r1' as Id,
    requiresExpiry: true,
    expiryDate: Temporal.PlainDate.from('2027-03-31'),
    zoneAtApproval: SYDNEY,
    issuerId: 'i1' as Id,
    issuerState: 'active',
    ...over,
  },
});
const at = (s: string): Temporal.Instant => Temporal.Instant.from(s);

describe('sellerCertificateValidAt', () => {
  it('is valid before the start of the day after expiry in the seller zone', () => {
    // Sydney is UTC+11 on 2027-03-31 (DST), so the boundary is 2027-03-31T13:00:00Z.
    const v = sellerCertificateValidAt(cert(), SYDNEY, at('2027-03-31T12:59:59Z'));
    expect(v.valid).toBe(true);
  });

  it('is invalid at the boundary, whatever the stored status says', () => {
    for (const status of ['approved', 'expired'] as const) {
      const v = sellerCertificateValidAt(cert({}, status), SYDNEY, at('2027-03-31T13:00:00Z'));
      expect(v).toEqual({ valid: false, reason: 'expired' });
    }
  });

  it('never extends: a later current-zone boundary does not revive a stored earlier one', () => {
    // Approved in Sydney (boundary 13:00Z); now in Brisbane (boundary 14:00Z). Earlier wins.
    const v = sellerCertificateValidAt(cert(), BRISBANE, at('2027-03-31T13:30:00Z'));
    expect(v).toEqual({ valid: false, reason: 'expired' });
  });

  it('brings the boundary forward when the current zone is earlier', () => {
    // Approved in Brisbane (14:00Z), now Sydney (13:00Z).
    const c = cert({ zoneAtApproval: BRISBANE });
    expect(sellerCertificateValidAt(c, SYDNEY, at('2027-03-31T13:30:00Z')).valid).toBe(false);
  });

  it('works in the synthetic Market zone', () => {
    const boundary = expiryBoundary(Temporal.PlainDate.from('2027-03-31'), ZZ);
    const c = cert({ zoneAtApproval: ZZ });
    expect(sellerCertificateValidAt(c, ZZ, boundary.subtract({ seconds: 1 })).valid).toBe(true);
    expect(sellerCertificateValidAt(c, ZZ, boundary).valid).toBe(false);
  });

  it('has no zone means not allowed', () => {
    expect(sellerCertificateValidAt(cert(), null, at('2027-01-01T00:00:00Z'))).toEqual({
      valid: false,
      reason: 'seller-zone-missing',
    });
  });

  it.each(['draft', 'in-review', 'changes-needed', 'declined', 'revoked'] as const)(
    'is invalid in status %s',
    (status) => {
      expect(
        sellerCertificateValidAt(cert({}, status), SYDNEY, at('2027-01-01T00:00:00Z')).valid,
      ).toBe(false);
    },
  );

  it('is invalid without an approved submission or for a derecognised issuer', () => {
    const none: SellerCertificationView = {
      certificateId: 'c1' as Id,
      status: 'approved',
      approved: null,
    };
    expect(sellerCertificateValidAt(none, SYDNEY, at('2027-01-01T00:00:00Z')).valid).toBe(false);
    const d = cert({ issuerState: 'derecognised' });
    expect(sellerCertificateValidAt(d, SYDNEY, at('2027-01-01T00:00:00Z')).valid).toBe(false);
  });

  it('keeps a closed-to-new issuer valid and honours a type that does not require expiry', () => {
    expect(
      sellerCertificateValidAt(
        cert({ issuerState: 'closed-to-new' }),
        SYDNEY,
        at('2027-01-01T00:00:00Z'),
      ).valid,
    ).toBe(true);
    const c = cert({ requiresExpiry: false, expiryDate: null });
    expect(sellerCertificateValidAt(c, SYDNEY, at('2099-01-01T00:00:00Z'))).toMatchObject({
      valid: true,
      expiresAt: null,
    });
  });

  it('fails closed when expiry is required but missing', () => {
    expect(
      sellerCertificateValidAt(cert({ expiryDate: null }), SYDNEY, at('2027-01-01T00:00:00Z')),
    ).toEqual({
      valid: false,
      reason: 'expiry-missing',
    });
  });
});
