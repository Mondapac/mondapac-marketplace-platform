import type { Id } from '@mondapac/shared-kernel';
import {
  buildCategoryOverrideContent,
  buildTaxOverrideContent,
  freezeWorkingCopy,
  optionKeyOf,
} from './revision-freeze';
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
    labelsFor: () => ({}),
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
      {
        variantId: v(1),
        position: 1,
        optionKey: '',
        optionValues: {},
        labels: {},
        gtin: null,
        shippingWeightGrams: null,
        shippingLengthMm: null,
        shippingWidthMm: null,
        shippingHeightMm: null,
        imageIds: [],
      },
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
    expect(found).toContainEqual({ path: 'texts', code: 'unknown' });
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
    expect(found).toContainEqual({ path: 'texts', code: 'unknown' });
  });

  describe('per-variant fields (variants V4)', () => {
    const two = (
      first: Record<string, unknown>,
      second: Record<string, unknown> = {},
      gallery: string[] = ['i1', 'i2', 'i3'],
    ) =>
      base({
        variantModel: 'options',
        liveVariantIds: [v(1), v(2)],
        content: {
          ...base().content,
          imageIds: gallery,
          variants: [
            { variantId: v(1), optionValues: { size: 'l' }, ...first },
            { variantId: v(2), optionValues: { size: 's' }, ...second },
          ],
        },
      });
    const foundIn = (input: FreezeInput) =>
      issues(input).map((issue) => `${issue.path}:${issue.code}`);

    it('freezes a GTIN-13 as 14 digits, shipping values and ordered picks', () => {
      const result = freezeWorkingCopy(
        two({
          gtin: '4006381333931',
          shippingWeightGrams: 450,
          shippingLengthMm: 200,
          shippingWidthMm: 100,
          shippingHeightMm: 50,
          imageIds: ['i3', 'i1'],
        }),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.variants[0]).toMatchObject({
        gtin: '04006381333931',
        shippingWeightGrams: 450,
        shippingLengthMm: 200,
        shippingWidthMm: 100,
        shippingHeightMm: 50,
        imageIds: ['i3', 'i1'],
      });
      expect(result.value.variants[1]).toMatchObject({
        gtin: null,
        shippingWeightGrams: null,
        shippingLengthMm: null,
        imageIds: [],
      });
    });

    it.each(['4006381333932', '12345', 'abcdefghijklm', '40063813339311', ''])(
      'refuses the GTIN %j without echoing it',
      (gtin) => {
        const found = issues(two({ gtin }));
        expect(found).toContainEqual({ path: 'variants.0.gtin', code: 'gtin.invalid' });
        expect(JSON.stringify(found)).not.toContain(gtin === '' ? '\u0000' : gtin);
      },
    );

    it('refuses the same GTIN on two variants of one product, in any written form', () => {
      expect(foundIn(two({ gtin: '4006381333931' }, { gtin: '04006381333931' }))).toEqual([
        'variants.1.gtin:duplicate',
      ]);
    });

    it('refuses out-of-range or non-integer shipping values and half-set dimensions', () => {
      expect(
        foundIn(
          two(
            { shippingWeightGrams: 0, shippingLengthMm: 1.5, shippingWidthMm: 5 },
            { shippingWeightGrams: 1_000_001 },
          ),
        ),
      ).toEqual(
        expect.arrayContaining([
          'variants.0.shippingWeightGrams:invalid',
          'variants.0.shippingLengthMm:invalid',
          'variants.0.shippingHeightMm:required',
          'variants.1.shippingWeightGrams:invalid',
        ]),
      );
    });

    it('refuses a pick outside the gallery, a repeated pick and too many picks', () => {
      expect(foundIn(two({ imageIds: ['i1', 'i9', 'i1'] }))).toEqual([
        'variants.0.imageIds.1:unknown',
        'variants.0.imageIds.2:duplicate',
      ]);
      const gallery = Array.from({ length: 21 }, (_, index) => `g${index}`);
      expect(foundIn(two({ imageIds: gallery }, {}, gallery))).toEqual([
        'variants.0.imageIds:too-many',
      ]);
    });

    it('lets a Simple product carry the fields of its one variant', () => {
      const result = freezeWorkingCopy(
        base({
          content: {
            ...base().content,
            imageIds: ['i1'],
            variants: [{ variantId: v(1), gtin: '96385074', imageIds: ['i1'] }],
          },
        }),
      );
      expect(result.ok && result.value.variants[0]).toMatchObject({
        gtin: '00000096385074',
        imageIds: ['i1'],
      });
    });
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

    it('refuses option separators and prototype keys in option sets (L3, L4)', () => {
      const bad = (entry: Record<string, unknown>) =>
        issues(configurable([{ variantId: v(1), ...entry }]));
      expect(bad({ optionValues: { a: 'b;c=d' } })).toContainEqual({
        path: 'variants.0.optionValues',
        code: 'invalid',
      });
      expect(bad({ optionValues: { 'a=b': 'c' } })).toContainEqual({
        path: 'variants.0.optionValues',
        code: 'invalid',
      });
      expect(bad({ optionValues: JSON.parse('{"__proto__": "x"}') })).toContainEqual({
        path: 'variants.0.optionValues',
        code: 'invalid',
      });
    });

    it('writes the built labels, not anything the draft carries (V2)', () => {
      const result = freezeWorkingCopy({
        ...configurable([
          {
            variantId: v(1),
            optionValues: { size: 'l' },
            labels: { [locale]: 'Typed by a seller' },
          },
        ]),
        labelsFor: (options) => ({ [locale]: `built:${options['size']}` }),
      });
      expect(result.ok && result.value.variants[0]?.labels).toEqual({ [locale]: 'built:l' });
    });

    it('leaves a locale without a built label out of the variant', () => {
      const result = freezeWorkingCopy({
        ...configurable([{ variantId: v(1), optionValues: { size: 'l' } }]),
        labelsFor: () => ({}),
      });
      expect(result.ok && result.value.variants[0]?.labels).toEqual({});
    });

    it('requires option values', () => {
      expect(issues(configurable([{ variantId: v(1) }]))).toContainEqual({
        path: 'variants.0.optionValues',
        code: 'required',
      });
    });
  });

  describe('topics (product tags T2)', () => {
    const T = Array.from(
      { length: 11 },
      (_, n) => `0197a1b2-0000-7000-8000-${String(n + 1).padStart(12, '0')}`,
    );
    const withTopics = (topicIds: unknown) => base({ content: { ...base().content, topicIds } });

    it('reads an absent list as none and keeps the order entered', () => {
      const none = freezeWorkingCopy(base());
      expect(none.ok && none.value.topicIds).toEqual([]);
      const some = freezeWorkingCopy(withTopics([T[2], T[0], T[1]]));
      expect(some.ok && some.value.topicIds).toEqual([T[2], T[0], T[1]]);
    });

    it('accepts ten topics and refuses an eleventh at topicIds', () => {
      expect(freezeWorkingCopy(withTopics(T.slice(0, 10))).ok).toBe(true);
      expect(issues(withTopics(T))).toContainEqual({ path: 'topicIds', code: 'too-many' });
    });

    it('refuses a repeat, a non-id and a non-list at their places', () => {
      expect(issues(withTopics([T[0], T[0]]))).toEqual([{ path: 'topicIds.1', code: 'duplicate' }]);
      expect(issues(withTopics([T[0], 'x', 7]))).toEqual([
        { path: 'topicIds.1', code: 'invalid' },
        { path: 'topicIds.2', code: 'invalid' },
      ]);
      expect(issues(withTopics('t'))).toEqual([{ path: 'topicIds', code: 'invalid' }]);
      expect(issues(withTopics({ 0: T[0] }))).toEqual([{ path: 'topicIds', code: 'invalid' }]);
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

    it('keeps the topics of the published content', () => {
      const topics = [
        '0197a1b2-0000-7000-8000-000000000001',
        '0197a1b2-0000-7000-8000-000000000002',
      ];
      const result = buildTaxOverrideContent({ ...published(), topicIds: topics }, tax[1], tax);
      expect(result.ok && result.value.topicIds).toEqual(topics);
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

describe('buildCategoryOverrideContent (C5a)', () => {
  const content = (categoryIds: string[]): RevisionContent =>
    ({ categoryIds, taxCategoryCode: 'GST', topicIds: ['t1'] }) as unknown as RevisionContent;
  const ids = (r: ReturnType<typeof buildCategoryOverrideContent>) =>
    r.ok ? r.value.categoryIds : r.error.code;

  it('replaces the category in place and keeps the rest of the content', () => {
    const result = buildCategoryOverrideContent(content(['a', 'b']), 'b', 'y');
    expect(ids(result)).toEqual(['a', 'y']);
    expect(result.ok && result.value.topicIds).toEqual(['t1']);
  });
  it('makes the target primary when the source was primary', () => {
    expect(ids(buildCategoryOverrideContent(content(['a', 'b']), 'a', 'y'))).toEqual(['y', 'b']);
  });
  it('inserts the target once when it is already on the revision', () => {
    expect(ids(buildCategoryOverrideContent(content(['a', 'b', 'y']), 'b', 'y'))).toEqual([
      'a',
      'y',
    ]);
  });
  it('moves an existing target to primary when the source was primary', () => {
    expect(ids(buildCategoryOverrideContent(content(['a', 'b', 'y']), 'a', 'y'))).toEqual([
      'y',
      'b',
    ]);
  });
  it('refuses a source that is not on the revision, and the same category', () => {
    expect(ids(buildCategoryOverrideContent(content(['a']), 'x', 'y'))).toBe('category.unchanged');
    expect(ids(buildCategoryOverrideContent(content(['a']), 'a', 'a'))).toBe('category.unchanged');
  });
});

describe('optionKeyOf', () => {
  it('does not depend on key order', () => {
    expect(optionKeyOf({ b: '2', a: '1' })).toBe(optionKeyOf({ a: '1', b: '2' }));
  });
});
