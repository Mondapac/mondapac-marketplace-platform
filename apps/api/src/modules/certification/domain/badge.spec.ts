import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { decide } from './claim-rule';
import type { ClaimFacts } from './claim-rule';
import type { CertificationTypeCode, ClaimQuery, TimeZoneId } from './claim-types';
import { BADGE_FIELDS } from './badge';
import type { ApprovedSubmissionView, SellerZones } from './validity';

// Badge data (certification design 4.5; brief AC 23). Every case runs for AU and for the
// synthetic Market ZZ (other zone, other type code), per CLAUDE.md.
const id = <K extends string>(s: string): Id<K> => s as Id<K>;
const z = (s: string): TimeZoneId => s as TimeZoneId;

interface Fixture {
  readonly name: string;
  readonly typeCode: CertificationTypeCode;
  readonly zone: TimeZoneId;
  /** The instant of 00:00 on 2028-01-01 in `zone`: the boundary of an expiry on 2027-12-31. */
  readonly boundary: Temporal.Instant;
}
const MARKETS: readonly Fixture[] = [
  {
    name: 'AU',
    typeCode: 'halal' as CertificationTypeCode,
    zone: z('Australia/Brisbane'),
    boundary: Temporal.Instant.from('2027-12-31T14:00:00Z'),
  },
  {
    name: 'ZZ',
    typeCode: 'zz-kosher' as CertificationTypeCode,
    zone: z('Pacific/Auckland'),
    boundary: Temporal.Instant.from('2027-12-31T11:00:00Z'),
  },
];
const now = Temporal.Instant.from('2027-06-01T00:00:00Z');

const queryFor = (m: Fixture): ClaimQuery => ({
  sellerId: id('seller-1'),
  productId: id('product-1'),
  productRevisionId: id('prev-1'),
  variantId: null,
  typeCode: m.typeCode,
  handling: 'SEALED_ORIGINAL',
  attestationRecorded: true,
  platformCategoryPaths: [[id('cat-1')]],
});

const submission = (
  m: Fixture,
  over: Partial<ApprovedSubmissionView> = {},
): ApprovedSubmissionView => ({
  submissionId: id('sub-1'),
  typeRevisionId: id('trev-approved'),
  verificationMode: 'THIRD_PARTY_DOCUMENT',
  requiresExpiry: true,
  expiryDate: Temporal.PlainDate.from('2027-12-31'),
  zoneAtApproval: m.zone,
  issuerId: id('issuer-1'),
  issuerState: 'active',
  issuerDisplayName: 'Registry Issuer Name',
  verifiedWithIssuer: false,
  ...over,
});

const factsFor = (
  m: Fixture,
  over: Partial<ApprovedSubmissionView> = {},
  zones: SellerZones = { zone: m.zone, addressZone: m.zone },
): ClaimFacts => ({
  // The published revision differs from the one the certificate was approved under.
  type: { publishedRevisionId: id('trev-published'), defaultBasis: 'SELLER_REQUIRED' },
  policy: null,
  sellerZones: zones,
  sellerCertificate: {
    certificateId: id('cert-1'),
    status: 'approved',
    approved: submission(m, over),
  },
});

describe.each(MARKETS)('badge data ($name)', (m) => {
  const query = queryFor(m);

  it('is built from the allowed decision: type, basis, revision approved under, issuer, expiry date and zone', () => {
    const d = decide(query, factsFor(m), now);
    expect(d.allowed).toBe(true);
    expect(d.badge).toEqual({
      typeCode: m.typeCode,
      typeRevisionId: 'trev-approved',
      basis: 'SELLER',
      sellerClaim: false,
      issuer: { id: 'issuer-1', displayName: 'Registry Issuer Name' },
      validUntilLocalDate: Temporal.PlainDate.from('2027-12-31'),
      validUntilZone: m.zone,
      verifiedWithIssuer: false,
      reviewedByPlatform: true,
    });
    // The badge names what the decision names: one source, never a second reading.
    expect(d.badge?.basis).toBe(d.basis);
    expect(d.badge?.typeRevisionId).toBe(d.certificate?.typeRevisionId);
    expect(d.badge?.issuer?.id).toBe(d.certificate?.issuerId);
    expect(d.certificate?.validUntil).toEqual(m.boundary);
  });

  it('holds only the allow-listed fields: nothing personal (no number, holder, document, reviewer, scope, seller)', () => {
    const d = decide(query, factsFor(m, { verifiedWithIssuer: true }), now);
    expect(Object.keys(d.badge!).sort()).toEqual([...BADGE_FIELDS].sort());
    expect(Object.keys(d.badge!.issuer!).sort()).toEqual(['displayName', 'id']);
    const text = JSON.stringify(d.badge);
    for (const absent of ['cert-1', 'sub-1', 'seller-1', 'product-1']) {
      expect(text).not.toContain(absent);
    }
  });

  it('is null whenever the decision is not allowed', () => {
    const at = m.boundary;
    expect(decide(query, factsFor(m), at)).toMatchObject({ allowed: false, badge: null });
    expect(decide(query, { ...factsFor(m), sellerCertificate: null }, now).badge).toBeNull();
    expect(decide(query, { ...factsFor(m), sellerZones: null }, now).badge).toBeNull();
    expect(decide(query, { ...factsFor(m), type: null }, now).badge).toBeNull();
    const notApplicable: ClaimFacts = {
      ...factsFor(m),
      type: { publishedRevisionId: id('trev-published'), defaultBasis: 'NOT_APPLICABLE' },
    };
    expect(decide(query, notApplicable, now).badge).toBeNull();
    expect(decide(query, factsFor(m, { issuerState: 'derecognised' }), now).badge).toBeNull();
  });

  it('marks verified-with-issuer only from the named submission, and never changes "allowed"', () => {
    const verified = decide(query, factsFor(m, { verifiedWithIssuer: true }), now);
    const plain = decide(query, factsFor(m), now);
    expect(verified.badge?.verifiedWithIssuer).toBe(true);
    expect(plain.badge?.verifiedWithIssuer).toBe(false);
    expect({ ...verified, badge: null }).toEqual({ ...plain, badge: null });
    // Past the boundary a verified submission is denied like any other.
    expect(decide(query, factsFor(m, { verifiedWithIssuer: true }), m.boundary)).toMatchObject({
      allowed: false,
      badge: null,
    });
  });

  it('is a seller claim for SELF_DECLARATION, never verified with an issuer, with no issuer when none is named', () => {
    const d = decide(
      query,
      factsFor(m, {
        verificationMode: 'SELF_DECLARATION',
        verifiedWithIssuer: true,
        issuerId: null,
        issuerState: null,
        issuerDisplayName: null,
      }),
      now,
    );
    expect(d.badge).toMatchObject({
      sellerClaim: true,
      verifiedWithIssuer: false,
      issuer: null,
      basis: 'SELLER',
    });
  });

  it('reads an unknown verification mode as a seller claim (the weaker badge, fail closed)', () => {
    const d = decide(
      query,
      factsFor(m, { verificationMode: 'SOMETHING_NEW' as never, verifiedWithIssuer: true }),
      now,
    );
    expect(d.badge).toMatchObject({ sellerClaim: true, verifiedWithIssuer: false });
  });

  it('never invents an issuer name: an issuer id without a name shows no issuer', () => {
    const d = decide(query, factsFor(m, { issuerDisplayName: null }), now);
    expect(d.allowed).toBe(true);
    expect(d.badge?.issuer).toBeNull();
  });

  it('is never verified with issuer when no issuer is shown (no id, or no registry name)', () => {
    const noName = decide(
      query,
      factsFor(m, { issuerDisplayName: null, verifiedWithIssuer: true }),
      now,
    );
    expect(noName.badge).toMatchObject({ issuer: null, verifiedWithIssuer: false });
    const noIssuer = decide(
      query,
      factsFor(m, {
        issuerId: null,
        issuerState: null,
        issuerDisplayName: null,
        verifiedWithIssuer: true,
      }),
      now,
    );
    expect(noIssuer.allowed).toBe(true);
    expect(noIssuer.badge).toMatchObject({ issuer: null, verifiedWithIssuer: false });
  });

  it('has no validity date when the type revision approved under does not require one', () => {
    const d = decide(query, factsFor(m, { requiresExpiry: false }), now);
    expect(d.badge).toMatchObject({ validUntilLocalDate: null, validUntilZone: null });
    expect(d.certificate?.validUntil).toBeNull();
  });

  it('names the zone that gave the earliest boundary (ADR-0005; design 2.4 rule 2)', () => {
    // The address zone is ahead of the chosen zone and of the zone at approval: it decides.
    const ahead = z('Pacific/Kiritimati'); // UTC+14
    const d = decide(query, factsFor(m, {}, { zone: m.zone, addressZone: ahead }), now);
    expect(d.badge?.validUntilZone).toBe(ahead);
    expect(d.badge?.validUntilLocalDate).toEqual(Temporal.PlainDate.from('2027-12-31'));
  });
});
