import { changedTexts, draftTextsOf, restoreRefused, valueAt } from './draft-texts';

// The closed draft shape and the per-field restore of catalog design 6.1, 6.2. Locales come from
// the Market, so both fixtures' locale sets are exercised.
const FIXTURES = [
  { code: 'AU', supported: ['en', 'ar'], defaultLocale: 'en' },
  { code: 'ZZ', supported: ['zz', 'en'], defaultLocale: 'zz' },
] as const;

describe.each(FIXTURES)('draft texts in market $code', ({ supported, defaultLocale }) => {
  const [first, second] = supported;
  const read = (content: Record<string, unknown>) =>
    draftTextsOf(content, supported, defaultLocale);

  it('finds every text field of a full draft with its place', () => {
    const content = {
      texts: {
        [first]: { name: 'N', shortDescription: 'S', description: 'D' },
        [second]: { name: 'M' },
      },
      categoryIds: ['c1'],
      taxCategoryCode: 'taxable',
      attributeValues: {
        colour: 'red',
        sizes: ['s', 'm'],
        title: { [first]: 'T1', [second]: 'T2' },
        weight: 3,
        organic: true,
        note: null,
      },
      variants: [{ variantId: 'v1', optionValues: { size: 'l' }, labels: { [first]: 'Large' } }],
      imageIds: [],
    };
    const result = read(content);
    expect(result.ok && result.value.map((t) => [t.field, t.ref, t.locale, t.text])).toEqual([
      ['product.name', null, first, 'N'],
      ['product.short-description', null, first, 'S'],
      ['product.description', null, first, 'D'],
      ['product.name', null, second, 'M'],
      ['product.attribute-text-value', 'colour', defaultLocale, 'red'],
      ['product.attribute-text-value', 'sizes', defaultLocale, 's'],
      ['product.attribute-text-value', 'sizes', defaultLocale, 'm'],
      ['product.attribute-text-value', 'title', first, 'T1'],
      ['product.attribute-text-value', 'title', second, 'T2'],
      ['product.variant-label', 'v1', first, 'Large'],
    ]);
  });

  it('refuses a draft that repeats a variant id, so no label escapes the check', () => {
    const variants = [
      { variantId: 'v1', labels: { [defaultLocale]: 'Large' } },
      { variantId: 'v1', labels: { [defaultLocale]: 'halal' } },
    ];
    const result = read({ variants });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('working-copy.invalid-content');
  });

  it('accepts an empty draft', () => {
    expect(read({})).toEqual({ ok: true, value: [] });
  });

  it.each([
    ['an unknown top-level key', { extra: 'halal' }],
    ['a locale the Market does not list', { texts: { fr: { name: 'x' } } }],
    ['an unknown text key', { texts: { en: { slogan: 'x' } } }],
    ['a non-string name', { texts: { en: { name: { deep: 'halal' } } } }],
    ['texts that are not an object', { texts: 'halal' }],
    ['a bad attribute code', { attributeValues: { 'bad code!': 'x' } }],
    ['an object attribute value with a bad locale', { attributeValues: { a: { fr: 'x' } } }],
    ['a nested attribute value', { attributeValues: { a: { en: { x: 'y' } } } }],
    ['an array of non-strings', { attributeValues: { a: [1, 2] } }],
    ['a variant with an unknown key', { variants: [{ variantId: 'v1', note: 'halal' }] }],
    [
      'a variant option value with free text',
      { variants: [{ variantId: 'v1', optionValues: { size: 'very large' } }] },
    ],
    [
      'a variant label in an unlisted locale',
      { variants: [{ variantId: 'v1', labels: { fr: 'x' } }] },
    ],
    ['a category id that is free text', { categoryIds: ['free text'] }],
    ['a tax code that is free text', { taxCategoryCode: 'not a code!' }],
  ])('refuses %s as a whole', (_name, content) => {
    expect(read(content as Record<string, unknown>)).toEqual({
      ok: false,
      error: { code: 'working-copy.invalid-content' },
    });
  });

  describe('changed texts and restore', () => {
    const stored = {
      texts: { [first]: { name: 'Old name', description: 'Old description' } },
      attributeValues: { colour: 'red' },
      variants: [
        { variantId: 'v1', labels: { [first]: 'One' } },
        { variantId: 'v2', labels: { [first]: 'Two' } },
      ],
    };

    it('keeps only the texts that differ from the stored draft', () => {
      const content = {
        texts: { [first]: { name: 'New name', description: 'Old description' } },
        attributeValues: { colour: 'red', shape: 'round' },
        variants: [
          { variantId: 'v2', labels: { [first]: 'Two' } },
          { variantId: 'v1', labels: { [first]: 'Uno' } },
        ],
      };
      const all = read(content);
      const changed = all.ok ? changedTexts(content, all.value, stored) : [];
      expect(changed.map((t) => t.text)).toEqual(['New name', 'round', 'Uno']);
    });

    it('treats every text as changed when nothing is stored', () => {
      const content = { texts: { [first]: { name: 'A' } } };
      const all = read(content);
      expect(all.ok && changedTexts(content, all.value, null)).toHaveLength(1);
    });

    it('puts a refused text back to its stored value, or removes it when none was stored', () => {
      const content = {
        texts: { [first]: { name: 'halal name', description: 'fine' } },
        attributeValues: { colour: 'halal red', shape: 'halal round' },
        variants: [
          { variantId: 'v2', labels: { [first]: 'halal two' } },
          { variantId: 'v1', labels: { [first]: 'One' } },
        ],
      };
      const all = read(content);
      if (!all.ok) throw new Error('shape');
      const refusedPaths = all.value.filter((t) => t.text.includes('halal')).map((t) => t.path);
      const restored = restoreRefused(content, stored, refusedPaths);
      expect(valueAt(restored, ['texts', first, 'name'])).toBe('Old name');
      expect(valueAt(restored, ['texts', first, 'description'])).toBe('fine');
      expect(valueAt(restored, ['attributeValues', 'colour'])).toBe('red');
      expect(valueAt(restored, ['attributeValues', 'shape'])).toBeUndefined();
      expect(valueAt(restored, ['variants', { variantId: 'v2' }, 'labels', first])).toBe('Two');
      expect(valueAt(restored, ['variants', { variantId: 'v1' }, 'labels', first])).toBe('One');
      // The input is untouched.
      expect(valueAt(content, ['texts', first, 'name'])).toBe('halal name');
    });

    it('removes a refused text when nothing is stored at all', () => {
      const content = { texts: { [first]: { name: 'halal' } } };
      const restored = restoreRefused(content, null, [['texts', first, 'name']]);
      expect(valueAt(restored, ['texts', first, 'name'])).toBeUndefined();
    });
  });
});
