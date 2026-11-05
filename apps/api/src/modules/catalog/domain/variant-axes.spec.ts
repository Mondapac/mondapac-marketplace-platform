import type { AttributeField } from '@mondapac/shared-kernel';
import { axesOfOptionValues, axisFieldsOf, optionFieldsOf, selectedAxesOf } from './variant-axes';

const field = (code: string, over: Partial<AttributeField> = {}): AttributeField => ({
  code,
  dataType: 'select',
  localizable: false,
  required: false,
  isVariantOption: true,
  material: false,
  claimChecked: true,
  bounds: { options: [] },
  ...over,
});

const fields = [field('size'), field('note', { isVariantOption: false }), field('colour')];

describe('variant axes', () => {
  it('takes the family option fields, or the selected ones in family order', () => {
    expect(optionFieldsOf(fields).map((f) => f.code)).toEqual(['size', 'colour']);
    expect(axisFieldsOf(fields, undefined).map((f) => f.code)).toEqual(['size', 'colour']);
    expect(axisFieldsOf(fields, ['colour']).map((f) => f.code)).toEqual(['colour']);
    expect(axisFieldsOf(fields, ['colour', 'size', 'note']).map((f) => f.code)).toEqual([
      'size',
      'colour',
    ]);
  });

  it('reads the selection of a draft, and nothing when it names none', () => {
    expect(selectedAxesOf({ variantAxes: ['size'] })).toEqual(['size']);
    expect(selectedAxesOf({})).toBeUndefined();
    expect(selectedAxesOf({ variantAxes: 'size' })).toBeUndefined();
  });

  it('derives the axes of a revision from the option values of its variants', () => {
    expect(
      axesOfOptionValues([
        { optionValues: { size: 's' } },
        { optionValues: { colour: 'r', size: 'm' } },
      ]),
    ).toEqual(['colour', 'size']);
    expect(axesOfOptionValues([])).toEqual([]);
  });
});
