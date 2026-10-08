import type { Id } from '@mondapac/shared-kernel';
import { buildTaxOverrideContent, freezeWorkingCopy, optionKeyOf } from './revision-freeze';
import type { FreezeInput } from './revision-freeze';
import type { RevisionContent } from './revision-content';

const v = (n: number): Id<'Variant'> => `v${n}` as Id<'Variant'>;

// Two fixture Markets with different default locale and tax lists.
const MARKETS = [
  { code: 'AU', locale: 'en-AU', tax: ['GST', 'GST_FREE'] },
  { code: 'ZZ', locale: 'zz-ZZ', tax: ['STD', 'ZERO'] },
] as const;

describe.each(MARKETS)('revision freeze in market $code', ({ locale, tax }) => {
  const base = (over: Partial<FreezeInput> = {}): FreezeInput => ({
    content: {
      texts: { [locale]: { name: 'Dates', description: ' ' } },
      categoryIds: ['c1'],
      taxCategoryCode: tax[0],
      attributeValues: {},
      imageIds: [],
    },
    defaultLocale: locale,
    supportedLocales: [locale],
    taxCategoryCodes: tax,
    variantModel: 'single',
    liveVariantIds: [v(1)],
    maxVariants: 3,
    schemaRef: { familyRevisionId: 'f1', definitionRevisionIds: [] },
    contentSchemaVersion: 1,
    ...over,
  });

  const issues = (input: FreezeInput) => {
    const result = freezeWorkingCopy(input);
    if (result.ok) throw new Error('expected issues');
    return result.error;
  };

  it('freezes a ready Simple draft with its one implicit variant', () => {
    const result = freezeWorkingCopy(base());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.texts[locale]).toEqual({
      name: 'Dates',
      shortDescription: null,
      description: null,
    });
    expect(result.value.variants).toEqual([
      { variantId: v(1), position: 1, optionKey: '', optionValues: {}, labels: {} },
    ]);
  });

  it('lists every place the draft is not ready', () => {
    const found = issues(
      base({ content: { texts: {}, categoryIds: [], taxCategoryCode: 'NOPE' } }),
    );
    expect(found.map((issue) => `${issue.path}:${issue.code}`)).toEqual(
      expect.arrayContaining([
        `texts.${locale}.name:required`,
        'categoryIds:required',
        'taxCategoryCode:unknown',
      ]),
    );
  });

  it('requires a name in the default locale only', () => {
    const found = issues(base({ content: { ...base().content, texts: { other: { name: 'x' } } } }));
    expect(found).toContainEqual({ path: `texts.${locale}.name`, code: 'required' });
    expect(found).toContainEqual({ path: 'texts.other', code: 'unknown' });
  });

  it('rejects duplicate categories and prototype-polluting keys', () => {
    const found = issues(
      base({
        content: {
          ...base().content,
          categoryIds: ['c1', 'c1'],
          texts: { [locale]: { name: 'x' }, ['__proto__']: { name: 'y' } },
        },
      }),
    );
    expect(found).toContainEqual({ path: 'categoryIds.1', code: 'duplicate' });
    expect(found).toContainEqual({ path: 'texts.__proto__', code: 'invalid' });
  });

  describe('Configurable variants', () => {
    const configurable = (variants: unknown, over: Partial<FreezeInput> = {}) =>
      base({
        variantModel: 'options',
        liveVariantIds: [v(1), v(2)],
        content: { ...base().content, variants },
        ...over,
      });

    it('freezes named live variants with sorted option keys', () => {
      const result = freezeWorkingCopy(
        configurable([
          {
            variantId: v(1),
            optionValues: { size: 'l', colour: 'red' },
            labels: { [locale]: 'L' },
          },
          { variantId: v(2), optionValues: { size: 's', colour: 'red' } },
        ]),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.variants.map((variant) => variant.optionKey)).toEqual([
        'colour=red;size=l',
        'colour=red;size=s',
      ]);
      expect(result.value.variants.map((variant) => variant.position)).toEqual([1, 2]);
    });

    it('rejects none, unknown ids, repeated ids, repeated option sets and too many', () => {
      expect(issues(configurable([]))).toContainEqual({ path: 'variants', code: 'required' });
      expect(issues(configurable([{ variantId: v(9), optionValues: { a: 'b' } }]))).toContainEqual({
        path: 'variants.0.variantId',
        code: 'unknown',
      });
      expect(
        issues(
          configurable([
            { variantId: v(1), optionValues: { a: 'b' } },
            { variantId: v(1), optionValues: { a: 'c' } },
          ]),
        ),
      ).toContainEqual({ path: 'variants.1.variantId', code: 'duplicate' });
      expect(
        issues(
          configurable([
            { variantId: v(1), optionValues: { a: 'b' } },
            { variantId: v(2), optionValues: { a: 'b' } },
          ]),
        ),
      ).toContainEqual({ path: 'variants.1.optionValues', code: 'duplicate' });
      expect(
        issues(
          configurable(
            [
              { variantId: v(1), optionValues: { a: 'b' } },
              { variantId: v(2), optionValues: { a: 'c' } },
            ],
            { maxVariants: 1 },
          ),
        ),
      ).toContainEqual({ path: 'variants', code: 'too-many' });
    });

    it('refuses option separators and prototype keys in option sets and labels (L3, L4)', () => {
      const bad = (entry: Record<string, unknown>) =>
        issues(configurable([{ variantId: v(1), ...entry }]));
      expect(bad({ optionValues: { a: 'b;c=d' } })).toContainEqual({
        path: 'variants.0.optionValues.a',
        code: 'invalid',
      });
      expect(bad({ optionValues: { 'a=b': 'c' } })).toContainEqual({
        path: 'variants.0.optionValues.a=b',
        code: 'invalid',
      });
      expect(bad({ optionValues: JSON.parse('{"__proto__": "x"}') })).toContainEqual({
        path: 'variants.0.optionValues.__proto__',
        code: 'invalid',
      });
      expect(
        bad({ optionValues: { a: 'b' }, labels: JSON.parse('{"constructor": "x"}') }),
      ).toContainEqual({
        path: 'variants.0.labels.constructor',
        code: 'invalid',
      });
    });

    it('requires option values', () => {
      expect(issues(configurable([{ variantId: v(1) }]))).toContainEqual({
        path: 'variants.0.optionValues',
        code: 'required',
      });
    });
  });

  describe('tax override content (AC 36)', () => {
    const published = (): RevisionContent => {
      const result = freezeWorkingCopy(base());
      if (!result.ok) throw new Error('not ready');
      return result.value;
    };

    it('changes only the tax category', () => {
      const result = buildTaxOverrideContent(published(), tax[1], tax);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual({ ...published(), taxCategoryCode: tax[1] });
    });

    it('refuses an unknown or unchanged code', () => {
      expect(buildTaxOverrideContent(published(), 'NOPE', tax)).toEqual({
        ok: false,
        error: { code: 'tax-category.unknown' },
      });
      expect(buildTaxOverrideContent(published(), tax[0], tax)).toEqual({
        ok: false,
        error: { code: 'tax-category.unchanged' },
      });
    });
  });
});

describe('optionKeyOf', () => {
  it('does not depend on key order', () => {
    expect(optionKeyOf({ b: '2', a: '1' })).toBe(optionKeyOf({ a: '1', b: '2' }));
  });
});
