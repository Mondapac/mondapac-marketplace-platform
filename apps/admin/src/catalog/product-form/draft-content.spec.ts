import { describe, expect, it } from 'vitest';
import { contentFrom, variantRowsOf, variantsWith } from './draft-content.ts';

const parts = {
  categoryIds: [] as string[],
  taxCategoryCode: '',
  attributeValues: {},
  variants: null,
};

describe('contentFrom variantAxes', () => {
  it('writes the axes of a configurable product', () => {
    expect(contentFrom({}, { ...parts, variantAxes: ['size'] })['variantAxes']).toEqual(['size']);
  });

  it('keeps an empty list, because an absent key means every candidate to the server', () => {
    const next = contentFrom({ variantAxes: ['size'] }, { ...parts, variantAxes: [] });
    expect(next['variantAxes']).toEqual([]);
  });

  it('leaves the stored axes alone for null and undefined', () => {
    expect(
      contentFrom({ variantAxes: ['a'] }, { ...parts, variantAxes: null })['variantAxes'],
    ).toEqual(['a']);
    expect(contentFrom({ variantAxes: ['a'] }, parts)['variantAxes']).toEqual(['a']);
    expect('variantAxes' in contentFrom({}, parts)).toBe(false);
  });
});

describe('variant fields in the saved draft', () => {
  it('reads and writes a variant barcode, shipping size and photo picks without losing them', () => {
    const content = {
      variants: [
        {
          variantId: 'v1',
          gtin: '4006381333931',
          shippingWeightGrams: 250,
          shippingLengthMm: 100,
          shippingWidthMm: 80,
          shippingHeightMm: 20,
          imageIds: ['i1', 'i2'],
        },
      ],
    };
    const rows = variantRowsOf(content, [{ variantId: 'v1', state: 'published' }]);
    expect(rows[0]).toMatchObject({
      gtin: '4006381333931',
      weightGrams: '250',
      imageIds: ['i1', 'i2'],
    });
    expect(variantsWith(rows)).toEqual([{ ...content.variants[0] }]);
  });
});
