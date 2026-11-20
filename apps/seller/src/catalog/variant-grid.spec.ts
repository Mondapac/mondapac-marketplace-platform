import { describe, expect, it } from 'vitest';
import { NO_VARIANT_FIELDS, type VariantRow } from './draft-content.ts';
import type { FormField } from './types.ts';
import {
  activeOptionsOf,
  axesOf,
  combinationsOf,
  nearLimit,
  previewLabels,
  rowOf,
} from './variant-grid.ts';

const select = (code: string, codes: string[], isVariantOption = true): FormField => ({
  code,
  dataType: 'select',
  localizable: false,
  required: false,
  isVariantOption,
  bounds: {},
  names: { en: code },
  options: codes.map((c) => ({ code: c, labels: { en: c } })),
});
const FIELDS = [
  select('size', ['s', 'l']),
  select('colour', ['red', 'blue']),
  select('fit', ['a'], false),
];
const row = (key: string, options: Record<string, string>): VariantRow => ({
  variantId: key,
  key,
  state: 'proposed',
  options,
  variantCode: null,
  ...NO_VARIANT_FIELDS,
});

describe('variant grid logic', () => {
  it('reads the axes a draft names, in feature set order, ignoring unknown and non-variant codes', () => {
    expect(axesOf({ variantAxes: ['colour', 'size', 'fit', 'x'] }, [], FIELDS)).toEqual([
      'size',
      'colour',
    ]);
    expect(axesOf({ variantAxes: [] }, [row('a', { size: 's' })], FIELDS)).toEqual([]);
  });

  it('takes the axes of an older draft from the options its variants use', () => {
    expect(axesOf({}, [row('a', { colour: 'red' })], FIELDS)).toEqual(['colour']);
    expect(axesOf(undefined, [], FIELDS)).toEqual([]);
  });

  it('lists the active options the rows use, once each', () => {
    const rows = [row('a', { size: 'l' }), row('b', { size: 'l' }), row('c', { size: 's' })];
    expect(activeOptionsOf(rows, ['size'])).toEqual({ size: ['l', 's'] });
  });

  it('builds the combinations in the feature set order of axes and options', () => {
    const combos = combinationsOf(FIELDS, ['size', 'colour'], {
      size: ['l', 's'],
      colour: ['blue', 'red'],
    });
    expect(combos.map((combo) => combo.key)).toEqual([
      'size=s;colour=red',
      'size=s;colour=blue',
      'size=l;colour=red',
      'size=l;colour=blue',
    ]);
    expect(combinationsOf(FIELDS, [], {})).toEqual([]);
    expect(combinationsOf(FIELDS, ['size'], { size: [] })).toEqual([]);
  });

  it('finds the row of a combination', () => {
    const rows = [row('a', { size: 's', colour: 'red' })];
    const [first, second] = combinationsOf(FIELDS, ['size', 'colour'], {
      size: ['s'],
      colour: ['red', 'blue'],
    });
    expect(first && rowOf(rows, first, ['size', 'colour'])?.key).toBe('a');
    expect(second && rowOf(rows, second, ['size', 'colour'])).toBeUndefined();
  });

  it('warns from nine tenths of the limit until it is reached', () => {
    expect(nearLimit(89, 100)).toBe(false);
    expect(nearLimit(90, 100)).toBe(true);
    expect(nearLimit(99, 100)).toBe(true);
    expect(nearLimit(100, 100)).toBe(false);
  });
});

describe('variant label preview', () => {
  const sized = [
    select('size', ['s', 'l']),
    {
      ...select('colour', ['red']),
      options: [{ code: 'red', labels: { en: 'Red' } }],
    },
  ];
  // The first axis has English and French names, the second only English.
  const fields: FormField[] = [
    { ...sized[0]!, options: [{ code: 'l', labels: { en: 'Large', fr: 'Grand' } }] },
    sized[1]!,
  ];

  it('joins the option labels of the axes in order, per language', () => {
    expect(previewLabels(fields, ['size', 'colour'], { size: 'l', colour: 'red' }, ['en'])).toEqual(
      { en: 'Large · Red' },
    );
    expect(previewLabels(fields, ['size'], { size: 'l' }, ['en', 'fr'])).toEqual({
      en: 'Large',
      fr: 'Grand',
    });
  });

  it('gives no label in a language where any option has no name, nothing borrowed', () => {
    expect(
      previewLabels(fields, ['size', 'colour'], { size: 'l', colour: 'red' }, ['en', 'fr']),
    ).toEqual({ en: 'Large · Red', fr: null });
  });

  it('gives none without axes or for an option that is not chosen', () => {
    expect(previewLabels(fields, [], {}, ['en'])).toEqual({ en: null });
    expect(previewLabels(fields, ['size'], {}, ['en'])).toEqual({ en: null });
  });
});
