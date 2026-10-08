import { reservedWordsOf } from './reserved-words';
import { parseShopSlug } from './shop-slug';

const RESERVED_WORDS = reservedWordsOf({
  slugs: ['admin', 'api', 'mondapac'],
  claimWords: ['halal', 'official', 'verified'],
});

describe('parseShopSlug', () => {
  it('accepts a normal slug and lower-cases and trims it', () => {
    expect(parseShopSlug('  Green-Grocer-99 ', RESERVED_WORDS)).toEqual({
      ok: true,
      value: 'green-grocer-99',
    });
  });

  it.each(['ab', 'a'.repeat(51), '-abc', 'abc-', 'a--b', 'a_b', 'sho p', 'café', '', 'a.b'])(
    'refuses the format of %j',
    (slug) => {
      expect(parseShopSlug(slug, RESERVED_WORDS)).toEqual({
        ok: false,
        error: { code: 'slug.format' },
      });
    },
  );

  it('accepts the length bounds 3 and 50', () => {
    expect(parseShopSlug('abc', RESERVED_WORDS).ok).toBe(true);
    expect(parseShopSlug('a'.repeat(50), RESERVED_WORDS).ok).toBe(true);
  });

  it('refuses a non-string as a format error', () => {
    expect(parseShopSlug(42, RESERVED_WORDS)).toEqual({
      ok: false,
      error: { code: 'slug.format' },
    });
    expect(parseShopSlug(undefined, RESERVED_WORDS).ok).toBe(false);
  });

  it('refuses a reserved whole slug and a claim word in any token', () => {
    for (const slug of ['admin', 'API', 'halal', 'best-halal-meats', 'verified-seller-1']) {
      expect(parseShopSlug(slug, RESERVED_WORDS)).toEqual({
        ok: false,
        error: { code: 'slug.reserved' },
      });
    }
  });

  it('matches claim words per token, not as substrings', () => {
    expect(parseShopSlug('halalfoods', RESERVED_WORDS).ok).toBe(true);
    expect(parseShopSlug('officially-yours', RESERVED_WORDS).ok).toBe(true);
  });

  it('takes the reserved list as an argument', () => {
    const words = { slugs: new Set(['zz']), claimWords: new Set(['gold']) };
    expect(parseShopSlug('shiny-gold', words).ok).toBe(false);
    expect(parseShopSlug('halal-shop', words).ok).toBe(true);
  });
});
