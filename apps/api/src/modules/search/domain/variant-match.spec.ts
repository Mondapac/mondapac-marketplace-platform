import type { Id } from '@mondapac/shared-kernel';
import type { OfferVariantDocument } from './offer-document';
import { gtinOfQuery, matchVariants } from './variant-match';

// Variants V8: which variant a result opens on and its "From" price, and the exact-GTIN test.

const V1 = '01990000-0000-7000-8000-0000000000a1' as Id<'Variant'>;
const V2 = '01990000-0000-7000-8000-0000000000a2' as Id<'Variant'>;
const V3 = '01990000-0000-7000-8000-0000000000a3' as Id<'Variant'>;

const unit = (
  variantId: Id<'Variant'>,
  position: number,
  facetCodes: string[],
  amount: bigint | null,
  inStock = true,
): OfferVariantDocument => ({
  variantId,
  position,
  facetCodes,
  gtin: null,
  inStock,
  price: amount === null ? null : { amount, currency: 'AUD' },
});

// Rice: 1 kg ($5), 5 kg ($20, out of stock), 10 kg ($35).
const rice = {
  facetCodes: ['brand=al-safa'],
  variants: [
    unit(V3, 2, ['weight=10kg'], 3500n),
    unit(V1, 0, ['weight=1kg'], 500n),
    unit(V2, 1, ['weight=5kg'], 2000n, false),
  ],
};

describe('matchVariants', () => {
  it('without a variant filter: no variant chosen, the lowest in-stock price, varying', () => {
    expect(matchVariants({ ...rice, groups: [], price: null })).toEqual({
      variantId: null,
      price: { from: { amount: 500n, currency: 'AUD' }, varies: true },
    });
  });

  it('a product-attribute filter alone does not narrow to a variant', () => {
    expect(matchVariants({ ...rice, groups: [['brand=al-safa']], price: null }).variantId).toBe(
      null,
    );
  });

  it('a variant filter picks the matching in-stock variant and its price', () => {
    expect(matchVariants({ ...rice, groups: [['weight=10kg']], price: null })).toEqual({
      variantId: V3,
      price: { from: { amount: 3500n, currency: 'AUD' }, varies: false },
    });
  });

  it('an out-of-stock variant never matches', () => {
    expect(matchVariants({ ...rice, groups: [['weight=5kg']], price: null })).toEqual({
      variantId: null,
      price: null,
    });
  });

  it('several values: the first matching variant by the owner order, the lowest of them', () => {
    expect(
      matchVariants({ ...rice, groups: [['weight=10kg', 'weight=1kg']], price: null }),
    ).toEqual({
      variantId: V1,
      price: { from: { amount: 500n, currency: 'AUD' }, varies: true },
    });
  });

  it('the price filter reads the matching variants only', () => {
    expect(matchVariants({ ...rice, groups: [], price: { min: 1000n, max: null } })).toEqual({
      variantId: V3,
      price: { from: { amount: 3500n, currency: 'AUD' }, varies: false },
    });
    expect(
      matchVariants({ ...rice, groups: [['weight=1kg']], price: { min: 1000n, max: null } }),
    ).toEqual({ variantId: null, price: null });
  });

  it('an unpriced variant never matches and gives no price', () => {
    const units = { facetCodes: [], variants: [unit(V1, 0, ['weight=1kg'], null)] };
    expect(matchVariants({ ...units, groups: [], price: null })).toEqual({
      variantId: null,
      price: null,
    });
  });

  it('two axes must be held by the same variant', () => {
    const shirt = {
      facetCodes: [],
      variants: [
        unit(V1, 0, ['colour=red', 'size=s'], 1000n),
        unit(V2, 1, ['colour=blue', 'size=m'], 1200n),
      ],
    };
    expect(
      matchVariants({ ...shirt, groups: [['colour=red'], ['size=m']], price: null }).price,
    ).toBe(null);
    expect(
      matchVariants({ ...shirt, groups: [['colour=blue'], ['size=m']], price: null }).variantId,
    ).toBe(V2);
  });
});

describe('gtinOfQuery', () => {
  it('reads GTIN-8, 12, 13 and 14 with a valid check digit as 14 digits', () => {
    expect(gtinOfQuery('9300633603366')).toBe('09300633603366');
    expect(gtinOfQuery('930 0633 60336 6')).toBe('09300633603366');
    expect(gtinOfQuery('036000291452')).toBe('00036000291452');
    expect(gtinOfQuery('96385074')).toBe('00000096385074');
    expect(gtinOfQuery('09300633603366')).toBe('09300633603366');
  });

  it('is null for words, wrong lengths and a wrong check digit', () => {
    expect(gtinOfQuery('rice 10kg')).toBe(null);
    expect(gtinOfQuery('12345')).toBe(null);
    expect(gtinOfQuery('9300633603369')).toBe(null);
    expect(gtinOfQuery('')).toBe(null);
  });
});
