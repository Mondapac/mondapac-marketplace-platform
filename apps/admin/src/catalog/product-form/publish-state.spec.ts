import { describe, expect, it } from 'vitest';
import { blockersOf, listOf } from './publish-state.ts';
import type { FormField } from './types.ts';

const field = (code: string, required: boolean): FormField => ({
  code,
  dataType: 'text',
  localizable: false,
  required,
  isVariantOption: false,
  bounds: {},
  names: { en: code },
  options: [],
});

describe('blockersOf', () => {
  const full = {
    name: 'Rice',
    categoryIds: ['c1'],
    taxCategoryCode: 'gst',
    fields: [field('grain', true), field('variety', false)],
    inputs: { grain: 'Long' },
  };

  it('is empty when title, category, tax category and required details are there', () => {
    expect(blockersOf(full)).toEqual([]);
  });

  it('lists the gaps in the order title, category, tax category, required details', () => {
    expect(
      blockersOf({ ...full, name: '  ', categoryIds: [], taxCategoryCode: '', inputs: {} }),
    ).toEqual(['title', 'category', 'tax', 'details']);
  });

  it('counts a required detail as given for any non-empty value and ignores optional ones', () => {
    expect(blockersOf({ ...full, inputs: { grain: ' ' } })).toEqual(['details']);
    expect(blockersOf({ ...full, inputs: { grain: { en: 'Long' } } })).toEqual([]);
    expect(blockersOf({ ...full, inputs: { grain: { '': ' ' } } })).toEqual(['details']);
    expect(
      blockersOf({
        ...full,
        fields: [{ ...field('halal-ok', true), dataType: 'boolean' }],
        inputs: { 'halal-ok': false },
      }),
    ).toEqual([]);
    expect(
      blockersOf({
        ...full,
        fields: [{ ...field('tags', true), dataType: 'multi-select' }],
        inputs: { tags: [] },
      }),
    ).toEqual(['details']);
  });
});

describe('listOf', () => {
  it('joins with commas and "and"', () => {
    expect(listOf(['a'], 'en-AU')).toBe('a');
    expect(listOf(['a', 'b'], 'en-AU')).toBe('a and b');
    expect(listOf(['a', 'b', 'c'], 'en-AU')).toBe('a, b and c');
  });
});
