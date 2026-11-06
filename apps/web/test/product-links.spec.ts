import { describe, expect, it } from 'vitest';
import { productHref, productIdOfSegment, productSlug } from '../src/storefront/links.ts';

const ID = '3f2b8c1e-9a4d-4e6b-8f10-2d7c5a9b0e11';

describe('productSlug', () => {
  const table: readonly [string, string, string][] = [
    ['English', 'Halal Lamb Shoulder, 1 kg', 'halal-lamb-shoulder-1-kg'],
    ['accents folded', 'Crème brûlée à la façon de José', 'creme-brulee-a-la-facon-de-jose'],
    ['emoji dropped', '🔥 Hot sauce 🌶️ 250ml', 'hot-sauce-250ml'],
    ['digits kept', '5 kg Basmati Rice 2024', '5-kg-basmati-rice-2024'],
    ['apostrophe leaves no gap', "Baker's Choice Men’s Lamb", 'bakers-choice-mens-lamb'],
    ['runs of separators collapse', '  Lamb --  &  Beef //  Mix  ', 'lamb-beef-mix'],
    ['upper case folded', 'ABC XYZ', 'abc-xyz'],
    ['nothing usable (Persian)', 'گوشت گوسفندی', ''],
    ['nothing usable (symbols)', '!!! ???', ''],
    ['empty', '', ''],
  ];
  it.each(table)('%s', (_label, name, slug) => {
    expect(productSlug(name)).toBe(slug);
  });

  it('cuts a very long name at a word boundary, at most 60 characters', () => {
    const name = 'Premium halal grass fed lamb shoulder bone in slow cook roast family pack extra';
    const slug = productSlug(name);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toBe('premium-halal-grass-fed-lamb-shoulder-bone-in-slow-cook');
    expect(name.toLowerCase().replaceAll(' ', '-').startsWith(slug)).toBe(true);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('hard-cuts one very long word and never ends with a hyphen', () => {
    expect(productSlug('a'.repeat(100))).toBe('a'.repeat(60));
    expect(productSlug(`${'b'.repeat(59)} c`)).toBe('b'.repeat(59));
  });

  it('keeps only a-z, 0-9 and single hyphens whatever the name holds', () => {
    for (const name of [
      '../../etc/passwd',
      'a/b\\c?d#e%2Fx',
      '<script>alert(1)</script>',
      'x\n\ty',
    ]) {
      expect(productSlug(name)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$|^$/u);
    }
  });
});

describe('productHref', () => {
  it('is /p/<slug>-<id> when a name is known', () => {
    expect(productHref(ID, 'Halal Lamb Shoulder, 1 kg')).toBe(`/p/halal-lamb-shoulder-1-kg-${ID}`);
  });

  it('is /p/<id> with no name, or when the name leaves no slug', () => {
    expect(productHref(ID)).toBe(`/p/${ID}`);
    expect(productHref(ID, '')).toBe(`/p/${ID}`);
    expect(productHref(ID, 'گوشت')).toBe(`/p/${ID}`);
  });

  it('writes the id in lower case', () => {
    expect(productHref(ID.toUpperCase(), 'Lamb')).toBe(`/p/lamb-${ID}`);
  });

  it('leaves an id that is not a catalog UUID as the whole path, encoded', () => {
    expect(productHref('lamb-shoulder', 'Halal lamb shoulder')).toBe('/p/lamb-shoulder');
    expect(productHref('a/b?c', 'x')).toBe('/p/a%2Fb%3Fc');
  });
});

describe('productIdOfSegment', () => {
  it('takes the trailing UUID, whatever the name part says', () => {
    expect(productIdOfSegment(`lamb-${ID}`)).toBe(ID);
    expect(productIdOfSegment(`old-name-or-wrong-${ID.toUpperCase()}`)).toBe(ID);
    expect(productIdOfSegment(ID)).toBe(ID);
  });

  it('returns a segment with no UUID at its end as it is', () => {
    expect(productIdOfSegment('lamb-shoulder')).toBe('lamb-shoulder');
    expect(productIdOfSegment(`${ID}-lamb`)).toBe(`${ID}-lamb`);
  });
});
