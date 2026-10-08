import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { decide, resolveRequirement } from './claim-rule';
import type { ClaimFacts } from './claim-rule';
import type { CertificationTypeCode, ClaimQuery, TimeZoneId } from './claim-types';

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
  type: { publishedRevisionId: id('tr1'), defaultBasis: 'SELLER_REQUIRED' },
  policy: null,
  sellerZones: { zone: 'Australia/Sydney' as TimeZoneId, addressZone: 'Australia/Sydney' as TimeZoneId },
  sellerCertificate: {
    certificateId: id('c1'),
    status: 'approved',
    approved: {
      submissionId: id('s1'),
      typeRevisionId: id('tr1'),
      requiresExpiry: true,
      expiryDate: Temporal.PlainDate.from('2027-12-31'),
      zoneAtApproval: 'Australia/Sydney' as TimeZoneId,
      issuerId: id('i1'),
      issuerState: 'active',
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

describe('ClaimRule.decide (seller basis)', () => {
  it('allows with a valid seller certificate and echoes the inputs', () => {
    const d = decide(query, facts(), now);
    expect(d).toMatchObject({
      allowed: true,
      basis: 'SELLER',
      reason: 'allowed',
      inputs: query,
      evaluatedAt: now,
      badge: null,
    });
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
    const g = facts({ type: { publishedRevisionId: id('tr1'), defaultBasis: 'NOT_APPLICABLE' } });
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

  it('fails closed on SELLER_OR_MANUFACTURER without a seller certificate (manufacturer basis is slice 13)', () => {
    const f = facts({
      sellerCertificate: null,
      policy: { revisionId: id('p1'), matchedRows: [{ basis: 'SELLER_OR_MANUFACTURER' }] },
    });
    expect(decide(query, f, now)).toMatchObject({
      allowed: false,
      reason: 'no-valid-seller-certificate',
    });
  });
});
