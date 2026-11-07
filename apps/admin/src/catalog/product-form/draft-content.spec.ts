import { describe, expect, it } from 'vitest';
import { contentFrom } from './draft-content.ts';

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
