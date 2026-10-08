import { revisionTextsOf, summaryOf } from './revision-texts';
import type { RevisionContent } from './revision-content';

const FIXTURES = [
  { code: 'AU', supported: ['en', 'ar'], defaultLocale: 'en' },
  { code: 'ZZ', supported: ['zz', 'en'], defaultLocale: 'zz' },
] as const;

describe.each(FIXTURES)('revision texts in market $code', ({ supported, defaultLocale }) => {
  const content = (): RevisionContent => ({
    texts: {
      [defaultLocale]: { name: 'Dates', shortDescription: null, description: 'Sweet' },
    },
    categoryIds: ['c1'],
    taxCategoryCode: 'taxable',
    attributeValues: { origin: 'Iran', note: { [defaultLocale]: 'fresh' }, weight: 3 },
    variants: [
      {
        variantId: 'v1',
        position: 1,
        optionKey: 'size=l',
        optionValues: { size: 'l' },
        labels: { [defaultLocale]: 'Large' },
      },
    ],
    imageIds: [],
    schemaRef: { familyRevisionId: 'f1', definitionRevisionIds: [] },
    contentSchemaVersion: 1,
  });

  it('lists every stored text with its field, locale and ref', () => {
    const result = revisionTextsOf(content(), supported, defaultLocale);
    if (!result.ok) throw new Error('shape');
    expect(result.value.map(({ field, ref, locale, text }) => [field, ref, locale, text])).toEqual([
      ['product.name', null, defaultLocale, 'Dates'],
      ['product.description', null, defaultLocale, 'Sweet'],
      ['product.attribute-text-value', 'origin', defaultLocale, 'Iran'],
      ['product.attribute-text-value', 'note', defaultLocale, 'fresh'],
      ['product.variant-label', 'v1', defaultLocale, 'Large'],
    ]);
  });

  it('summarises names, categories, tax category, images and variants for the policy', () => {
    expect(summaryOf(content())).toEqual({
      names: { [defaultLocale]: 'Dates' },
      categoryIds: ['c1'],
      taxCategoryCode: 'taxable',
      imageIds: [],
      variantIds: ['v1'],
    });
  });
});
