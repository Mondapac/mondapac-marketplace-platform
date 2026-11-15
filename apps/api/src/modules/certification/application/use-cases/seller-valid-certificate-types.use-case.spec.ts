import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { TimeZoneId } from '../../domain/claim-types';
import type { ApprovedSubmissionView, SellerCertificationView } from '../../domain/validity';
import type {
  ClaimFactsReader,
  SellerCertificateRequest,
  SellerZoneAnswer,
  SellerZonesSource,
} from '../ports/claim-facts.ports';
import { sellerValidCertificateTypes } from './seller-valid-certificate-types.use-case';

// The valid-types answer of multi-culture package 3a on the one canonical measure
// `sellerCertificateValidAt` (ADR-0048 security review M1): the issuer allow-list, a required expiry,
// both seller zones and the earliest boundary across them, on both Market fixtures.

const FIXTURES = [
  {
    code: 'AU',
    type: 'halal',
    other: 'kosher',
    zone: 'Australia/Brisbane',
    far: 'Pacific/Kiritimati',
  },
  { code: 'ZZ', type: 'kosher', other: 'halal', zone: 'Asia/Tokyo', far: 'Pacific/Kiritimati' },
] as const;

const SELLER = '01990000-0000-7000-8000-0000000005e1' as Id<'Seller'>;
const OTHER_SELLER = '01990000-0000-7000-8000-0000000005e2' as Id<'Seller'>;

describe.each(FIXTURES)('sellerValidCertificateTypes in $code', (fx) => {
  const market = testMarketContext(fx.code, 'default');
  const context = testCallContext(market, 'system', 'valid-types-abcdef');
  // Noon UTC on 2026-11-12; the expiry date below is that day, so the boundary is 00:00 on the 13th
  // in each zone. Kiritimati (UTC+14) reaches it at 10:00 UTC on the 12th, before now.
  const now = Temporal.Instant.from('2026-11-12T12:00:00Z');

  const submission = (over: Partial<ApprovedSubmissionView> = {}): ApprovedSubmissionView => ({
    submissionId: '01990000-0000-7000-8000-00000000a001' as Id,
    typeRevisionId: '01990000-0000-7000-8000-00000000a002' as Id,
    verificationMode: 'THIRD_PARTY_DOCUMENT',
    requiresExpiry: true,
    expiryDate: Temporal.PlainDate.from('2026-11-12'),
    zoneAtApproval: fx.zone as TimeZoneId,
    issuerId: '01990000-0000-7000-8000-00000000a003' as Id,
    issuerState: 'active',
    issuerDisplayName: 'Issuer',
    verifiedWithIssuer: true,
    ...over,
  });
  const certificate = (
    over: Partial<ApprovedSubmissionView> = {},
    status: SellerCertificationView['status'] = 'approved',
  ): SellerCertificationView => ({
    certificateId: '01990000-0000-7000-8000-00000000a004' as Id,
    status,
    approved: submission(over),
  });

  let held: Map<string, SellerCertificationView>;
  let zones: Map<Id<'Seller'>, { zone: string | null; addressZone: string | null }>;
  let failing: 'facts' | 'zones' | null;
  const asked: SellerCertificateRequest[][] = [];
  const facts = {
    sellerCertificates: (_m: unknown, requests: readonly SellerCertificateRequest[]) => {
      asked.push([...requests]);
      if (failing === 'facts') return Promise.reject(new Error('down'));
      return Promise.resolve(
        requests.map((r) => ({
          ...r,
          certificate: held.get(`${r.sellerId}|${r.typeCode}`) ?? null,
        })),
      );
    },
  } as unknown as ClaimFactsReader;
  const zoneSource: SellerZonesSource = {
    zonesOf: (_c, ids) =>
      failing === 'zones'
        ? Promise.reject(new Error('down'))
        : Promise.resolve(
            new Map(
              ids.flatMap((id) => (zones.has(id) ? [[id, zones.get(id)!]] : [])),
            ) as SellerZoneAnswer,
          ),
  };
  const answer = (sellerIds: unknown = [SELLER], typeCodes: unknown = [fx.type, fx.other]) =>
    sellerValidCertificateTypes({ facts, zones: zoneSource, clock: new FixedClock(now) }, context, {
      sellerIds,
      typeCodes,
    });
  const validFor = async (sellerId = SELLER) => {
    const result = await answer();
    if (!result.ok) return result.error.code;
    return result.value.find((row) => row.sellerId === sellerId)?.validTypeCodes;
  };

  beforeEach(() => {
    held = new Map([
      [`${SELLER}|${fx.type}`, certificate({ expiryDate: Temporal.PlainDate.from('2027-01-31') })],
    ]);
    zones = new Map([[SELLER, { zone: fx.zone, addressZone: fx.zone }]]);
    failing = null;
    asked.length = 0;
  });

  it('answers the asked types the seller holds a valid certificate of, and only those', async () => {
    expect(await validFor()).toEqual([fx.type]);
    expect(asked).toEqual([
      [
        { sellerId: SELLER, typeCode: fx.type },
        { sellerId: SELLER, typeCode: fx.other },
      ],
    ]);
    const onlyOther = await answer([SELLER], [fx.other]);
    expect(onlyOther).toEqual({ ok: true, value: [{ sellerId: SELLER, validTypeCodes: [] }] });
  });

  it.each([
    ['a derecognised issuer', certificate({ issuerState: 'derecognised' })],
    ['a proposed issuer (not on the allow-list)', certificate({ issuerState: 'proposed' })],
    ['a required expiry with no date', certificate({ expiryDate: null })],
    ['a past boundary', certificate({ expiryDate: Temporal.PlainDate.from('2026-11-01') })],
    ['a stored status other than approved', certificate({}, 'revoked')],
  ])('is not valid with %s', async (_name, cert) => {
    held.set(`${SELLER}|${fx.type}`, cert);
    expect(await validFor()).toEqual([]);
  });

  it('a closed-to-new issuer and a type with no required expiry stay valid', async () => {
    held.set(`${SELLER}|${fx.type}`, certificate({ issuerState: 'closed-to-new' }));
    held.set(
      `${SELLER}|${fx.other}`,
      certificate({ requiresExpiry: false, expiryDate: null, issuerId: null, issuerState: null }),
    );
    expect(await validFor()).toEqual([fx.type, fx.other]);
  });

  it('takes the earliest boundary across the seller zones', async () => {
    held.set(`${SELLER}|${fx.type}`, certificate());
    // In the Market zone the certificate is still valid at noon UTC on its expiry day...
    expect(await validFor()).toEqual([fx.type]);
    // ...but a seller zone that reaches the next day first ends it.
    zones.set(SELLER, { zone: fx.zone, addressZone: fx.far });
    expect(await validFor()).toEqual([]);
  });

  it('a missing or unusable seller zone is not valid, never a default zone', async () => {
    zones.set(SELLER, { zone: fx.zone, addressZone: null });
    expect(await validFor()).toEqual([]);
    zones.set(SELLER, { zone: '+10:00', addressZone: fx.zone });
    expect(await validFor()).toEqual([]);
    zones.delete(SELLER);
    expect(await validFor()).toEqual([]);
  });

  it('answers one row per seller in the order asked', async () => {
    const result = await answer([OTHER_SELLER, SELLER, OTHER_SELLER]);
    expect(result).toEqual({
      ok: true,
      value: [
        { sellerId: OTHER_SELLER, validTypeCodes: [] },
        { sellerId: SELLER, validTypeCodes: [fx.type] },
      ],
    });
  });

  it.each(['facts', 'zones'] as const)('fails closed when the %s read fails', async (what) => {
    failing = what;
    expect(await validFor()).toBe('access.unavailable');
  });

  it('validates the input before any read', async () => {
    expect(await answer('x')).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(await answer(['not-an-id'])).toMatchObject({ ok: false });
    expect(await answer([SELLER], ['Halal!'])).toMatchObject({
      ok: false,
      error: { fields: [{ path: 'typeCodes', code: 'format' }] },
    });
    expect(
      await answer(
        [SELLER],
        Array.from({ length: 21 }, (_, n) => `t${n}`),
      ),
    ).toMatchObject({
      ok: false,
      error: { fields: [{ path: 'typeCodes', code: 'range' }] },
    });
    expect(asked).toEqual([]);
  });
});
