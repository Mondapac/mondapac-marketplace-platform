import type { AttributeField, AttributeSchema } from '@mondapac/shared-kernel';
import { buildVariantLabels } from './variant-labels';

const field = (
  code: string,
  options: { code: string; labels?: Record<string, string> }[],
  over: Partial<AttributeField> = {},
): AttributeField => ({
  code,
  dataType: 'select',
  localizable: false,
  required: false,
  isVariantOption: true,
  material: false,
  claimChecked: true,
  bounds: { options },
  ...over,
});

const schema = (fields: AttributeField[]): AttributeSchema => ({
  schemaRef: { familyCode: 'f', familyRevisionId: 'r' as never, definitionRevisionIds: [] },
  fields,
});

// Two Markets with different locale sets (AU en-AU + ar-AU, ZZ zz-ZZ + en).
describe.each([
  { code: 'AU', locales: ['en-AU', 'ar-AU'], first: 'en-AU', second: 'ar-AU' },
  { code: 'ZZ', locales: ['zz-ZZ', 'en'], first: 'zz-ZZ', second: 'en' },
] as const)('automatic variant labels in market $code', ({ locales, first, second }) => {
  const size = field('size', [
    { code: 'l', labels: { [first]: 'Large', [second]: 'L2' } },
    { code: 's', labels: { [first]: 'Small' } },
  ]);
  const colour = field('colour', [{ code: 'red', labels: { [first]: 'Red', [second]: 'R2' } }]);

  it('joins the option labels of the axes in family order, per locale', () => {
    const built = buildVariantLabels(schema([size, colour]), { colour: 'red', size: 'l' }, locales);
    expect(built).toEqual({ [first]: 'Large · Red', [second]: 'L2 · R2' });
  });

  it('is a single option label for one axis', () => {
    expect(buildVariantLabels(schema([size]), { size: 'l' }, locales)).toEqual({
      [first]: 'Large',
      [second]: 'L2',
    });
  });

  it('gives no label in a locale where any axis option has no label', () => {
    expect(
      buildVariantLabels(schema([size, colour]), { size: 's', colour: 'red' }, locales),
    ).toEqual({
      [first]: 'Small · Red',
    });
  });

  it('gives no label at all when the option is unknown or an axis is unset', () => {
    expect(
      buildVariantLabels(schema([size, colour]), { size: 'xl', colour: 'red' }, locales),
    ).toEqual({});
    expect(buildVariantLabels(schema([size, colour]), { size: 'l' }, locales)).toEqual({});
  });

  it('builds the label from the selected axes only, in family order (V3)', () => {
    const both = schema([size, colour]);
    expect(buildVariantLabels(both, { size: 'l' }, locales, ['size'])).toEqual({
      [first]: 'Large',
      [second]: 'L2',
    });
    expect(
      buildVariantLabels(both, { colour: 'red', size: 'l' }, locales, ['colour', 'size']),
    ).toEqual({
      [first]: 'Large · Red',
      [second]: 'L2 · R2',
    });
  });

  it('ignores a field that is not a variant axis and never reads the draft', () => {
    const note = field('note', [{ code: 'a', labels: { [first]: 'A' } }], {
      isVariantOption: false,
    });
    expect(buildVariantLabels(schema([note, size]), { size: 'l' }, locales)[first]).toBe('Large');
    expect(buildVariantLabels(schema([note]), {}, locales)).toEqual({});
  });

  it('does not take a label from a prototype key', () => {
    expect(
      buildVariantLabels(
        schema([size]),
        JSON.parse('{"__proto__": "x"}') as Record<string, string>,
        locales,
      ),
    ).toEqual({});
  });

  it('trims labels and treats a blank label as missing', () => {
    const blank = field('size', [{ code: 'l', labels: { [first]: ' Large ', [second]: '  ' } }]);
    expect(buildVariantLabels(schema([blank]), { size: 'l' }, locales)).toEqual({
      [first]: 'Large',
    });
  });
});
