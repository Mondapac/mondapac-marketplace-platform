import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { BADGE_FIELDS } from './badge';
import { decide, resolveRequirement } from './claim-rule';
import type { ClaimFacts } from './claim-rule';
import type { CertificationTypeCode, ClaimQuery, TimeZoneId } from './claim-types';
import type { ProductCertificationView } from './validity';

const id = <K extends string>(s: string): Id<K> => s as Id<K>;
const query: ClaimQuery = {
  sellerId: id('seller-1'),
  productId: id('product-1'),
  productRevisionId: id('prev-1'),
  variantId: null,
  typeCode: 'halal' as CertificationTypeCode,
  handling: 'SEALED_ORIGINAL',
  attestationRecorded: true,
  platformCategoryPaths: [],
};
const now = Temporal.Instant.from('2027-01-01T00:00:00Z');
const facts = (over: Partial<ClaimFacts> = {}): ClaimFacts => ({
  type: {
    publishedRevisionId: id('tr1'),
    defaultBasis: 'SELLER_REQUIRED',
    verificationMode: 'THIRD_PARTY_DOCUMENT',
  },
  policy: null,
  productCertificates: null,
  marketZone: 'Australia/Brisbane' as TimeZoneId,
  manufacturerBasisEnabled: true,
  sellerZones: {
    zone: 'Australia/Sydney' as TimeZoneId,
    addressZone: 'Australia/Sydney' as TimeZoneId,
  },
  sellerCertificate: {
    certificateId: id('c1'),
    status: 'approved',
    approved: {
      submissionId: id('s1'),
      typeRevisionId: id('tr1'),
      verificationMode: 'THIRD_PARTY_DOCUMENT',
      requiresExpiry: true,
      expiryDate: Temporal.PlainDate.from('2027-12-31'),
      zoneAtApproval: 'Australia/Sydney' as TimeZoneId,
      issuerId: id('i1'),
      issuerState: 'active',
      issuerDisplayName: 'Issuer One',
      verifiedWithIssuer: false,
    },
  },
  ...over,
});

describe('resolveRequirement', () => {
  it('uses the default when no row matches and the strictest of all rows otherwise', () => {
    expect(resolveRequirement('SELLER_REQUIRED', [])).toBe('SELLER_REQUIRED');
    expect(resolveRequirement('SELLER_REQUIRED', [{ basis: 'SELLER_OR_MANUFACTURER' }])).toBe(
      'SELLER_OR_MANUFACTURER',
    );
    expect(
      resolveRequirement('NOT_APPLICABLE', [
        { basis: 'SELLER_OR_MANUFACTURER' },
        { basis: 'SELLER_REQUIRED' },
      ]),
    ).toBe('SELLER_REQUIRED');
    expect(
      resolveRequirement('SELLER_REQUIRED', [
        { basis: 'NOT_APPLICABLE' },
        { basis: 'SELLER_OR_MANUFACTURER' },
      ]),
    ).toBe('NOT_APPLICABLE');
  });
});

describe('resolveRequirement, unknown values fail closed', () => {
  it('reads an unknown row basis or default as NOT_APPLICABLE, including prototype names', () => {
    for (const bogus of ['BOGUS', 'toString', 'constructor', '__proto__']) {
      expect(resolveRequirement('SELLER_REQUIRED', [{ basis: bogus as never }])).toBe(
        'NOT_APPLICABLE',
      );
      expect(resolveRequirement(bogus as never, [])).toBe('NOT_APPLICABLE');
    }
  });
});

describe('ClaimRule.decide (seller basis)', () => {
  it('allows with a valid seller certificate and echoes the inputs', () => {
    const d = decide(query, facts(), now);
    expect(d).toMatchObject({
      allowed: true,
      basis: 'SELLER',
      reason: 'allowed',
      inputs: query,
      evaluatedAt: now,
    });
    expect(d.badge).toMatchObject({ basis: 'SELLER', typeRevisionId: 'tr1' });
    expect(d.certificate).toMatchObject({
      kind: 'seller',
      certificateId: 'c1',
      versionId: 's1',
      typeRevisionId: 'tr1',
    });
  });

  it('denies an unknown type', () => {
    expect(decide(query, facts({ type: null }), now)).toMatchObject({
      allowed: false,
      reason: 'type-unknown',
    });
  });

  it('denies both bases under NOT_APPLICABLE, even with a valid certificate', () => {
    const f = facts({
      policy: { revisionId: id('p1'), matchedRows: [{ basis: 'NOT_APPLICABLE' }] },
    });
    expect(decide(query, f, now)).toMatchObject({
      allowed: false,
      reason: 'policy-not-applicable',
      policyRevisionId: 'p1',
    });
    const g = facts({
      type: {
        publishedRevisionId: id('tr1'),
        defaultBasis: 'NOT_APPLICABLE',
        verificationMode: 'THIRD_PARTY_DOCUMENT',
      },
    });
    expect(decide(query, g, now)).toMatchObject({
      allowed: false,
      reason: 'policy-not-applicable',
      policyRevisionId: null,
    });
  });

  it('denies without a certificate, with an expired one, and when the zone is missing', () => {
    expect(decide(query, facts({ sellerCertificate: null }), now).reason).toBe(
      'no-valid-seller-certificate',
    );
    expect(decide(query, facts(), Temporal.Instant.from('2028-06-01T00:00:00Z')).reason).toBe(
      'no-valid-seller-certificate',
    );
    expect(decide(query, facts({ sellerZones: null }), now).reason).toBe('seller-zone-missing');
  });

  it('fails closed on SELLER_OR_MANUFACTURER without a seller certificate and without any manufacturer certificate', () => {
    const f = facts({
      sellerCertificate: null,
      policy: { revisionId: id('p1'), matchedRows: [{ basis: 'SELLER_OR_MANUFACTURER' }] },
    });
    expect(decide(query, f, now)).toMatchObject({
      allowed: false,
      reason: 'not-covered',
      policyRevisionId: 'p1',
    });
  });
});

describe('ClaimRule.decide, more cases', () => {
  const sydneyBoundary = Temporal.Instant.from('2028-01-01T00:00:00Z').subtract({ hours: 11 });

  it('is exact at the boundary instant', () => {
    const f = facts({
      sellerCertificate: {
        ...facts().sellerCertificate!,
        approved: {
          ...facts().sellerCertificate!.approved!,
          expiryDate: Temporal.PlainDate.from('2027-12-31'),
        },
      },
    });
    expect(decide(query, f, sydneyBoundary.subtract({ seconds: 1 })).allowed).toBe(true);
    expect(decide(query, f, sydneyBoundary).reason).toBe('no-valid-seller-certificate');
  });

  it('denies a derecognised issuer and allows a closed-to-new one', () => {
    const withIssuer = (issuerState: 'derecognised' | 'closed-to-new') =>
      facts({
        sellerCertificate: {
          ...facts().sellerCertificate!,
          approved: { ...facts().sellerCertificate!.approved!, issuerState },
        },
      });
    expect(decide(query, withIssuer('derecognised'), now).reason).toBe(
      'no-valid-seller-certificate',
    );
    expect(decide(query, withIssuer('closed-to-new'), now).allowed).toBe(true);
  });

  it('maps a missing approved submission and a missing expiry date to no-valid-seller-certificate', () => {
    const noApproved = facts({
      sellerCertificate: { ...facts().sellerCertificate!, approved: null },
    });
    expect(decide(query, noApproved, now).reason).toBe('no-valid-seller-certificate');
    const noExpiry = facts({
      sellerCertificate: {
        ...facts().sellerCertificate!,
        approved: { ...facts().sellerCertificate!.approved!, expiryDate: null },
      },
    });
    expect(decide(query, noExpiry, now).reason).toBe('no-valid-seller-certificate');
  });

  it('denies requiresExpiry=false when the seller has no zone (a missing zone is never allowed)', () => {
    const f = facts({
      sellerZones: null,
      sellerCertificate: {
        ...facts().sellerCertificate!,
        approved: { ...facts().sellerCertificate!.approved!, requiresExpiry: false },
      },
    });
    expect(decide(query, f, now).reason).toBe('seller-zone-missing');
  });

  it('resolves the requirement in either row order and keeps the policy id only when a row matched', () => {
    const rows = (...b: ('SELLER_REQUIRED' | 'SELLER_OR_MANUFACTURER')[]) =>
      facts({ policy: { revisionId: id('p1'), matchedRows: b.map((basis) => ({ basis })) } });
    expect(
      decide(query, rows('SELLER_REQUIRED', 'SELLER_OR_MANUFACTURER'), now).policyRevisionId,
    ).toBe('p1');
    expect(decide(query, rows('SELLER_OR_MANUFACTURER', 'SELLER_REQUIRED'), now).allowed).toBe(
      true,
    );
    expect(decide(query, rows(), now).policyRevisionId).toBeNull();
    expect(
      resolveRequirement('SELLER_OR_MANUFACTURER', [
        { basis: 'NOT_APPLICABLE' },
        { basis: 'SELLER_REQUIRED' },
      ]),
    ).toBe('NOT_APPLICABLE');
  });

  it('runs on a synthetic Market: other zone, other default basis', () => {
    const zz = facts({
      type: {
        publishedRevisionId: id('tr1'),
        defaultBasis: 'NOT_APPLICABLE',
        verificationMode: 'THIRD_PARTY_DOCUMENT',
      },
      policy: { revisionId: id('p9'), matchedRows: [{ basis: 'SELLER_REQUIRED' }] },
      sellerZones: {
        zone: 'Pacific/Auckland' as TimeZoneId,
        addressZone: 'Pacific/Auckland' as TimeZoneId,
      },
      sellerCertificate: {
        ...facts().sellerCertificate!,
        approved: {
          ...facts().sellerCertificate!.approved!,
          zoneAtApproval: 'Pacific/Auckland' as TimeZoneId,
        },
      },
    });
    expect(decide(query, zz, now).allowed).toBe(true);
    expect(decide(query, { ...zz, sellerCertificate: null }, now).reason).toBe(
      'no-valid-seller-certificate',
    );
  });
});

describe('ClaimRule.decide, manufacturer basis (design 4.2 step 6; ADR-0012; AC 6)', () => {
  const policy = {
    revisionId: id('p1'),
    matchedRows: [{ basis: 'SELLER_OR_MANUFACTURER' as const }],
  };
  const productCert = (
    over: Partial<NonNullable<ProductCertificationView['approved']>> = {},
    status: ProductCertificationView['status'] = 'approved',
  ): ProductCertificationView => ({
    certificateId: id('pc1'),
    typeCode: query.typeCode,
    status,
    approved: {
      revisionId: id('pr1'),
      // The type revision the manufacturer revision was submitted and approved under (I1).
      typeRevisionId: id('tr-own'),
      requiresExpiry: true,
      expiryDate: Temporal.PlainDate.from('2027-06-30'),
      boundaryAtApproval: Temporal.Instant.from('2027-06-30T14:00:00Z'),
      issuerId: id('i9'),
      issuerState: 'active',
      issuerDisplayName: 'Manufacturer Issuer',
      verifiedWithIssuer: true,
      coverage: [
        { productId: query.productId, productRevisionId: query.productRevisionId, variantId: null },
      ],
      ...over,
    },
  });
  const manufacturer = (over: Partial<ClaimFacts> = {}): ClaimFacts =>
    facts({ sellerCertificate: null, policy, productCertificates: [productCert()], ...over });

  it('allows on a covering, valid manufacturer certificate with SEALED_ORIGINAL and an attestation', () => {
    const d = decide(query, manufacturer(), now);
    expect(d).toMatchObject({
      allowed: true,
      basis: 'MANUFACTURER',
      reason: 'allowed',
      policyRevisionId: 'p1',
      certificate: {
        kind: 'manufacturer',
        certificateId: 'pc1',
        versionId: 'pr1',
        issuerId: 'i9',
        // I1: the certificate's own approved type revision, as on the seller path.
        typeRevisionId: 'tr-own',
      },
    });
    expect(d.badge).toMatchObject({
      basis: 'MANUFACTURER',
      sellerClaim: false,
      verifiedWithIssuer: true,
      issuer: { id: 'i9', displayName: 'Manufacturer Issuer' },
      validUntilLocalDate: Temporal.PlainDate.from('2027-06-30'),
      validUntilZone: 'Australia/Brisbane',
      typeRevisionId: 'tr-own',
    });
    // The manufacturer badge holds the allow-listed fields only, like the seller badge.
    expect(Object.keys(d.badge!).sort()).toEqual([...BADGE_FIELDS].sort());
  });

  it('prefers the seller basis when both hold (ADR-0012 d7; AC 6)', () => {
    const d = decide(query, manufacturer({ sellerCertificate: facts().sellerCertificate }), now);
    expect(d).toMatchObject({ allowed: true, basis: 'SELLER' });
  });

  it('refuses every other handling (handling-requires-seller)', () => {
    for (const handling of ['REPACKED', 'PREPARED', 'FRESH'] as const) {
      expect(decide({ ...query, handling }, manufacturer(), now)).toMatchObject({
        allowed: false,
        reason: 'handling-requires-seller',
        badge: null,
      });
    }
  });

  it('refuses SEALED_ORIGINAL without the per-Offer attestation (attestation-missing)', () => {
    expect(decide({ ...query, attestationRecorded: false }, manufacturer(), now)).toMatchObject({
      allowed: false,
      reason: 'attestation-missing',
    });
  });

  it('fails closed with no manufacturer certificate, or when none was read (not-covered)', () => {
    expect(decide(query, manufacturer({ productCertificates: [] }), now).reason).toBe(
      'not-covered',
    );
    expect(decide(query, manufacturer({ productCertificates: null }), now).reason).toBe(
      'not-covered',
    );
  });

  it('never allows the manufacturer basis outside SELLER_OR_MANUFACTURER', () => {
    for (const basis of ['SELLER_REQUIRED', 'NOT_APPLICABLE'] as const) {
      const d = decide(
        query,
        manufacturer({ policy: { revisionId: id('p1'), matchedRows: [{ basis }] } }),
        now,
      );
      expect(d.allowed).toBe(false);
      expect(d.basis).toBeNull();
    }
    // The type default (never SELLER_OR_MANUFACTURER) with no matching row.
    expect(decide(query, manufacturer({ policy: null }), now)).toMatchObject({
      allowed: false,
      reason: 'no-valid-seller-certificate',
    });
  });

  it('takes the strictest row: a handling row tightens a SELLER_OR_MANUFACTURER category (M1)', () => {
    const d = decide(
      query,
      manufacturer({
        policy: {
          revisionId: id('p1'),
          matchedRows: [{ basis: 'SELLER_OR_MANUFACTURER' }, { basis: 'SELLER_REQUIRED' }],
        },
      }),
      now,
    );
    expect(d).toMatchObject({ allowed: false, reason: 'no-valid-seller-certificate' });
  });

  it('refuses a self-declaration type (CERT-40) and an unknown mode', () => {
    for (const verificationMode of ['SELF_DECLARATION', 'BOGUS'] as const) {
      const d = decide(
        query,
        manufacturer({
          type: {
            publishedRevisionId: id('tr1'),
            defaultBasis: 'SELLER_REQUIRED',
            verificationMode: verificationMode as 'SELF_DECLARATION',
          },
        }),
        now,
      );
      expect(d).toMatchObject({ allowed: false, reason: 'no-valid-seller-certificate' });
    }
  });

  it('matches coverage by product revision (M3) and variant (L1)', () => {
    const other = { ...query, productRevisionId: id<'ProductRevision'>('prev-2') };
    expect(decide(other, manufacturer(), now).reason).toBe('not-covered');
    const narrowed = manufacturer({
      productCertificates: [
        productCert({
          coverage: [
            {
              productId: query.productId,
              productRevisionId: query.productRevisionId,
              variantId: id('v1'),
            },
          ],
        }),
      ],
    });
    expect(decide(query, narrowed, now).reason).toBe('not-covered');
    expect(decide({ ...query, variantId: id('v1') }, narrowed, now).allowed).toBe(true);
    expect(decide({ ...query, variantId: id('v2') }, narrowed, now).reason).toBe('not-covered');
    // A whole-product entry covers every variant.
    expect(decide({ ...query, variantId: id('v2') }, manufacturer(), now).allowed).toBe(true);
  });

  it('refuses a certificate that is not approved, derecognised or expired', () => {
    for (const status of ['suspended', 'revoked', 'expired', 'in-review'] as const) {
      expect(
        decide(query, manufacturer({ productCertificates: [productCert({}, status)] }), now).reason,
      ).toBe('not-covered');
    }
    expect(
      decide(
        query,
        manufacturer({ productCertificates: [productCert({ issuerState: 'derecognised' })] }),
        now,
      ).reason,
    ).toBe('not-covered');
    const boundary = Temporal.Instant.from('2027-06-30T14:00:00Z');
    expect(decide(query, manufacturer(), boundary.subtract({ seconds: 1 })).allowed).toBe(true);
    expect(decide(query, manufacturer(), boundary).reason).toBe('not-covered');
  });

  it('uses the earlier of the stored and the current Market-zone boundary; no zone is not valid', () => {
    // Stored in Brisbane (UTC+10) at approval; the Market zone is now Tokyo (UTC+9): the stored
    // one is earlier and wins. The reverse: Tokyo stored, Brisbane now, Brisbane wins.
    const tokyo = Temporal.Instant.from('2027-06-30T15:00:00Z');
    expect(
      decide(
        query,
        manufacturer({ marketZone: 'Asia/Tokyo' as TimeZoneId }),
        tokyo.subtract({ minutes: 30 }),
      ).allowed,
    ).toBe(false);
    const storedTokyo = manufacturer({
      productCertificates: [productCert({ boundaryAtApproval: tokyo })],
    });
    expect(decide(query, storedTokyo, tokyo.subtract({ minutes: 30 })).allowed).toBe(false);
    expect(decide(query, manufacturer({ marketZone: null }), now).reason).toBe('not-covered');
    expect(decide(query, manufacturer({ marketZone: 'Not/AZone' as TimeZoneId }), now).reason).toBe(
      'not-covered',
    );
    expect(
      decide(
        query,
        manufacturer({ productCertificates: [productCert({ boundaryAtApproval: null })] }),
        now,
      ).reason,
    ).toBe('not-covered');
  });

  it('picks the covering certificate with the latest boundary; no expiry is the latest', () => {
    const later = productCert({
      revisionId: id('pr2'),
      expiryDate: Temporal.PlainDate.from('2028-06-30'),
      boundaryAtApproval: Temporal.Instant.from('2028-06-30T14:00:00Z'),
    });
    const d = decide(query, manufacturer({ productCertificates: [productCert(), later] }), now);
    expect(d.certificate?.versionId).toBe('pr2');
    const undated = productCert({ revisionId: id('pr3'), requiresExpiry: false });
    const e = decide(query, manufacturer({ productCertificates: [later, undated] }), now);
    expect(e.certificate).toMatchObject({ versionId: 'pr3', validUntil: null });
  });

  it('runs on the synthetic Market with its own zone (ZZ)', () => {
    const zz = manufacturer({
      marketZone: 'Asia/Tokyo' as TimeZoneId,
      productCertificates: [
        productCert({ boundaryAtApproval: Temporal.Instant.from('2027-06-30T15:00:00Z') }),
      ],
    });
    const d = decide(query, zz, now);
    expect(d).toMatchObject({ allowed: true, basis: 'MANUFACTURER' });
    expect(d.badge?.validUntilZone).toBe('Asia/Tokyo');
  });

  it('never lets a certificate of another type cover the query (Hassan L2)', () => {
    const other = { ...productCert(), typeCode: 'kosher' as CertificationTypeCode };
    expect(decide(query, manufacturer({ productCertificates: [other] }), now)).toMatchObject({
      allowed: false,
      reason: 'not-covered',
    });
    // With both, the certificate of the asked type wins even when the other ends later.
    const otherLater: ProductCertificationView = {
      ...productCert({
        revisionId: id('pr-other'),
        expiryDate: Temporal.PlainDate.from('2029-06-30'),
        boundaryAtApproval: Temporal.Instant.from('2029-06-30T14:00:00Z'),
      }),
      certificateId: id('pc-other'),
      typeCode: 'kosher' as CertificationTypeCode,
    };
    const d = decide(
      query,
      manufacturer({ productCertificates: [otherLater, productCert()] }),
      now,
    );
    expect(d).toMatchObject({ allowed: true, certificate: { certificateId: 'pc1' } });
  });

  it('reads SELLER_OR_MANUFACTURER as SELLER_REQUIRED while the Market switch is off (fail closed)', () => {
    const off = manufacturer({ manufacturerBasisEnabled: false });
    expect(decide(query, off, now)).toMatchObject({
      allowed: false,
      basis: null,
      reason: 'no-valid-seller-certificate',
      policyRevisionId: 'p1',
    });
    // The seller basis is unchanged.
    const seller = manufacturer({
      manufacturerBasisEnabled: false,
      sellerCertificate: facts().sellerCertificate,
    });
    expect(decide(query, seller, now)).toMatchObject({ allowed: true, basis: 'SELLER' });
    // Off, a missing seller zone still says so (the seller reason, never a manufacturer one).
    const noZone = manufacturer({
      manufacturerBasisEnabled: false,
      sellerCertificate: facts().sellerCertificate,
      sellerZones: null,
    });
    expect(decide(query, noZone, now).reason).toBe('seller-zone-missing');
  });

  it('treats anything but an explicit true switch as off', () => {
    for (const bogus of [undefined, null, 'true', 1]) {
      const f = manufacturer({ manufacturerBasisEnabled: bogus as never });
      expect(decide(query, f, now)).toMatchObject({ allowed: false });
    }
  });

  it('keeps NOT_APPLICABLE the strictest while the switch is off', () => {
    const f = manufacturer({
      manufacturerBasisEnabled: false,
      sellerCertificate: facts().sellerCertificate,
      policy: {
        revisionId: id('p1'),
        matchedRows: [{ basis: 'SELLER_OR_MANUFACTURER' }, { basis: 'NOT_APPLICABLE' }],
      },
    });
    expect(decide(query, f, now).reason).toBe('policy-not-applicable');
  });

  it('runs the switch per Market: off on AU, on for the synthetic Market (ZZ)', () => {
    const au = manufacturer({ manufacturerBasisEnabled: false });
    const zz = manufacturer({
      manufacturerBasisEnabled: true,
      marketZone: 'Asia/Tokyo' as TimeZoneId,
      productCertificates: [
        productCert({ boundaryAtApproval: Temporal.Instant.from('2027-06-30T15:00:00Z') }),
      ],
    });
    expect(decide(query, au, now).allowed).toBe(false);
    expect(decide(query, zz, now)).toMatchObject({ allowed: true, basis: 'MANUFACTURER' });
  });
});
