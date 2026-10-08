import type { AttributeField, AttributeSchema, Id } from '@mondapac/shared-kernel';
import { isProductTypeHandler } from '../product-type-handler';
import { configurableProductType } from './configurable';
import { simpleProductType } from './simple';

const option = (code: string, options: string[]): AttributeField => ({
  code,
  dataType: 'select',
  localizable: false,
  required: true,
  isVariantOption: true,
  material: false,
  claimChecked: true,
  bounds: { options: options.map((value) => ({ code: value })) },
});

const schemaOf = (...fields: AttributeField[]): AttributeSchema => ({
  schemaRef: { familyCode: 'f', familyRevisionId: 'r' as Id, definitionRevisionIds: [] },
  fields,
});

const SIZE_COLOUR = schemaOf(option('size', ['s', 'm']), option('colour', ['red', 'blue']));

describe('the structural product types', () => {
  it('fit the extension point and are frozen', () => {
    for (const handler of [simpleProductType, configurableProductType]) {
      expect(isProductTypeHandler(handler)).toBe(true);
      expect(Object.isFrozen(handler)).toBe(true);
    }
    expect([simpleProductType.typeCode, simpleProductType.variantModel]).toEqual([
      'simple',
      'single',
    ]);
    expect([configurableProductType.typeCode, configurableProductType.variantModel]).toEqual([
      'configurable',
      'options',
    ]);
  });

  it('rejects shapes that are not handlers', () => {
    for (const value of [null, 'simple', {}, { typeCode: 'x', variantModel: 'many' }]) {
      expect(isProductTypeHandler(value)).toBe(false);
    }
  });
});

describe('Simple: validateVariants', () => {
  it('takes exactly one variant with no option value', () => {
    const schema = schemaOf();
    expect(simpleProductType.validateVariants(schema, [{ optionValues: {} }], 100)).toEqual({
      ok: true,
    });
    expect(simpleProductType.validateVariants(schema, [], 100)).toEqual({
      ok: false,
      issues: [{ path: 'variants', code: 'variants.none' }],
    });
    expect(
      simpleProductType.validateVariants(schema, [{ optionValues: {} }, { optionValues: {} }], 100),
    ).toEqual({ ok: false, issues: [{ path: 'variants', code: 'variants.too-many' }] });
    expect(
      simpleProductType.validateVariants(schema, [{ optionValues: { size: 's' } }], 100),
    ).toEqual({ ok: false, issues: [{ path: 'variants[0]', code: 'variants.option-unknown' }] });
  });
});

describe('Configurable: validateVariants', () => {
  it('accepts distinct combinations of every option attribute', () => {
    expect(
      configurableProductType.validateVariants(
        SIZE_COLOUR,
        [
          { optionValues: { size: 's', colour: 'red' } },
          { optionValues: { size: 's', colour: 'blue' } },
          { optionValues: { size: 'm', colour: 'red' } },
        ],
        100,
      ),
    ).toEqual({ ok: true });
  });

  it('needs an option attribute of the family', () => {
    expect(
      configurableProductType.validateVariants(schemaOf(), [{ optionValues: {} }], 100),
    ).toEqual({
      ok: false,
      issues: [{ path: 'variants', code: 'variants.option-attribute-missing' }],
    });
    const notSelect: AttributeField = { ...option('size', []), dataType: 'text' };
    expect(
      configurableProductType.validateVariants(schemaOf(notSelect), [{ optionValues: {} }], 100).ok,
    ).toBe(false);
  });

  it('needs at least one variant and at most the limit', () => {
    expect(configurableProductType.validateVariants(SIZE_COLOUR, [], 100)).toEqual({
      ok: false,
      issues: [{ path: 'variants', code: 'variants.none' }],
    });
    const three = ['s', 'm', 's'].map((size, index) => ({
      optionValues: { size, colour: index === 2 ? 'blue' : 'red' },
    }));
    expect(configurableProductType.validateVariants(SIZE_COLOUR, three, 2)).toEqual({
      ok: false,
      issues: [{ path: 'variants', code: 'variants.too-many' }],
    });
  });

  it('refuses a missing, unknown or unlisted option value', () => {
    const result = configurableProductType.validateVariants(
      SIZE_COLOUR,
      [
        { optionValues: { size: 's' } },
        { optionValues: { size: 'xl', colour: 'red' } },
        { optionValues: { size: 's', colour: 'red', weight: '1' } },
      ],
      100,
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        { path: 'variants[0]', code: 'variants.option-missing' },
        { path: 'variants[1]', code: 'variants.option-unknown' },
        { path: 'variants[2]', code: 'variants.option-unknown' },
      ],
    });
  });

  it('refuses a repeated combination, naming the second variant', () => {
    expect(
      configurableProductType.validateVariants(
        SIZE_COLOUR,
        [
          { optionValues: { size: 's', colour: 'red' } },
          { optionValues: { colour: 'red', size: 's' } },
        ],
        100,
      ),
    ).toEqual({
      ok: false,
      issues: [{ path: 'variants[1]', code: 'variants.duplicate-combination' }],
    });
  });
});
