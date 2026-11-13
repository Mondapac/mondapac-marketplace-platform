import type { Id } from '@mondapac/shared-kernel';
import {
  cultureVisibility,
  lineCultureOf,
  visibleCultureCodes,
  type OfferCultureFacts,
  type VisibilityCulture,
} from './culture-visibility';
import type { EffectiveCategoryMarks } from './culture-category';

// The visibility rule of ADR-0047 decision 5 with ADR-0048 security review M2 (multi-culture
// package 3a), as a truth table, on both Market fixtures: AU with a halal culture and ZZ with a
// kosher one. Every row names the one fact that differs from a fully visible Offer.

const FIXTURES = [
  { market: 'AU', certified: 'muslim', plain: 'general', type: 'halal', other: 'kosher' },
  { market: 'ZZ', certified: 'jewish', plain: 'everyone', type: 'kosher', other: 'halal' },
] as const;

const marks = (
  visible: boolean,
  certificationMark: 'required' | 'neutral',
): EffectiveCategoryMarks => ({
  visible,
  certificationMark,
  visibleSource: { kind: 'default' },
  markSource: { kind: 'default' },
});

describe.each(FIXTURES)('culture visibility in $market', (fx) => {
  const certified: VisibilityCulture = {
    id: 'c-cert' as Id<'Culture'>,
    code: fx.certified,
    status: 'active',
    displayOrder: 20,
    requiredCertificationType: fx.type,
  };
  const plain: VisibilityCulture = {
    id: 'c-plain' as Id<'Culture'>,
    code: fx.plain,
    status: 'active',
    displayOrder: 10,
    requiredCertificationType: null,
  };

  /** A fully visible Offer in both cultures: member, visible category, valid certificate, tag allowed. */
  const visibleFacts = (): OfferCultureFacts => ({
    approvedCultureIds: new Set([certified.id, plain.id]),
    sellerValidTypes: new Set([fx.type]),
    categoryMarks: new Map([
      [certified.id, [marks(true, 'required')]],
      [plain.id, [marks(true, 'required')]],
    ]),
    allowedTagTypes: new Set([fx.type]),
  });

  type Row = readonly [string, (f: OfferCultureFacts) => OfferCultureFacts, boolean, string];
  const rows: readonly Row[] = [
    ['all conditions hold', (f) => f, true, 'visible'],
    [
      'the seller is not approved in the culture',
      (f) => ({ ...f, approvedCultureIds: new Set([plain.id]) }),
      false,
      'not-member',
    ],
    [
      'the category is hidden there',
      (f) => ({ ...f, categoryMarks: new Map([[certified.id, [marks(false, 'required')]]]) }),
      false,
      'category-hidden',
    ],
    [
      'one of two categories is hidden there',
      (f) => ({
        ...f,
        categoryMarks: new Map([[certified.id, [marks(true, 'neutral'), marks(false, 'neutral')]]]),
      }),
      false,
      'category-hidden',
    ],
    [
      'the product has no platform category',
      (f) => ({ ...f, categoryMarks: new Map([[certified.id, []]]) }),
      false,
      'no-category',
    ],
    [
      'the category marks were not read for the culture',
      (f) => ({ ...f, categoryMarks: new Map() }),
      false,
      'no-category',
    ],
    [
      'required category, no tag of the type',
      (f) => ({ ...f, allowedTagTypes: new Set() }),
      false,
      'tag-not-allowed',
    ],
    [
      'required category, a tag of another type only',
      (f) => ({ ...f, allowedTagTypes: new Set([fx.other]) }),
      false,
      'tag-not-allowed',
    ],
    [
      'neutral category, no tag: membership is enough',
      (f) => ({
        ...f,
        allowedTagTypes: new Set(),
        categoryMarks: new Map([[certified.id, [marks(true, 'neutral')]]]),
      }),
      true,
      'visible',
    ],
    [
      'one required and one neutral category, no tag: the required one decides',
      (f) => ({
        ...f,
        allowedTagTypes: new Set(),
        categoryMarks: new Map([[certified.id, [marks(true, 'neutral'), marks(true, 'required')]]]),
      }),
      false,
      'tag-not-allowed',
    ],
    [
      'certificate expired, revoked or of another type (M2), required category',
      (f) => ({ ...f, sellerValidTypes: new Set([fx.other]) }),
      false,
      'certificate-invalid',
    ],
    [
      'certificate no longer valid (M2), neutral category: hidden too',
      (f) => ({
        ...f,
        sellerValidTypes: new Set(),
        allowedTagTypes: new Set(),
        categoryMarks: new Map([[certified.id, [marks(true, 'neutral')]]]),
      }),
      false,
      'certificate-invalid',
    ],
  ];

  it.each(rows)('certified culture: %s', (_name, change, visible, reason) => {
    expect(cultureVisibility(certified, change(visibleFacts()))).toEqual({ visible, reason });
  });

  it('a culture with no required type needs membership and a visible category only', () => {
    const bare: OfferCultureFacts = {
      approvedCultureIds: new Set([plain.id]),
      sellerValidTypes: new Set(),
      categoryMarks: new Map([[plain.id, [marks(true, 'required')]]]),
      allowedTagTypes: new Set(),
    };
    expect(cultureVisibility(plain, bare)).toEqual({ visible: true, reason: 'visible' });
    expect(
      cultureVisibility(plain, {
        ...bare,
        categoryMarks: new Map([[plain.id, [marks(false, 'required')]]]),
      }),
    ).toEqual({ visible: false, reason: 'category-hidden' });
    expect(cultureVisibility(plain, { ...bare, approvedCultureIds: new Set() })).toEqual({
      visible: false,
      reason: 'not-member',
    });
  });

  it.each(['draft', 'inactive'] as const)('a %s culture shows nothing', (status) => {
    expect(cultureVisibility({ ...plain, status }, visibleFacts())).toEqual({
      visible: false,
      reason: 'culture-not-active',
    });
  });

  it('a seller of several cultures is evaluated per culture, and codes come in display order', () => {
    const facts = { ...visibleFacts(), allowedTagTypes: new Set<string>() };
    expect(visibleCultureCodes([certified, plain], facts)).toEqual([fx.plain]);
    expect(visibleCultureCodes([certified, plain], visibleFacts())).toEqual([
      fx.plain,
      fx.certified,
    ]);
    expect(visibleCultureCodes([certified, plain], null)).toEqual([]);
  });

  it('the line culture: a certified culture wins, then the lower display order (ADR-0047 d9)', () => {
    const second: VisibilityCulture = {
      ...plain,
      id: 'c-2' as Id<'Culture'>,
      code: 'b',
      displayOrder: 5,
    };
    const otherCertified: VisibilityCulture = {
      ...certified,
      id: 'c-3' as Id<'Culture'>,
      code: 'a',
      displayOrder: 30,
    };
    expect(lineCultureOf([plain, certified])).toBe(fx.certified);
    expect(lineCultureOf([plain, second])).toBe('b');
    expect(lineCultureOf([otherCertified, certified])).toBe(fx.certified);
    expect(lineCultureOf([])).toBeNull();
    // A tie on order too falls to the code, so the answer never depends on the input order.
    const twin: VisibilityCulture = { ...second, id: 'c-4' as Id<'Culture'>, code: 'a' };
    expect(lineCultureOf([second, twin])).toBe('a');
    expect(lineCultureOf([twin, second])).toBe('a');
  });
});
