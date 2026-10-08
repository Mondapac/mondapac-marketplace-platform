import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { AttributeDefinition } from './attribute-definition';

const NOW = Temporal.Instant.from('2026-10-08T00:00:00Z');
const input = (overrides: Partial<Parameters<typeof AttributeDefinition.create>[0]> = {}) => ({
  id: 'd1' as Id<'AttributeDefinition'>,
  revisionId: 'r1' as Id<'AttributeDefinitionRevision'>,
  marketId: 'ZZ' as MarketId,
  code: 'colour',
  dataType: 'select',
  localizable: false,
  material: false,
  isVariantOption: true,
  bounds: {},
  names: { xx: 'Colour' },
  options: [{ code: 'red', labels: { xx: 'Red' }, active: true, position: 0 }],
  createdByKind: 'seed' as const,
  now: NOW,
  ...overrides,
});

describe('AttributeDefinition.create', () => {
  it('builds an active definition at version 1, revision 1', () => {
    const result = AttributeDefinition.create(input());
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.state).toMatchObject({
      status: 'active',
      version: 1,
      revisionNo: 1,
      material: false,
      isVariantOption: true,
    });
  });

  it('accepts a textual and a numeric definition without options', () => {
    expect(
      AttributeDefinition.create(
        input({
          code: 'brand',
          dataType: 'text',
          isVariantOption: false,
          bounds: { maxLength: 80 },
          options: [],
        }),
      ).ok,
    ).toBe(true);
    expect(
      AttributeDefinition.create(
        input({
          code: 'weight',
          dataType: 'integer',
          isVariantOption: false,
          bounds: { min: 1, max: 9 },
          options: [],
        }),
      ).ok,
    ).toBe(true);
  });

  const bad = { dataType: 'text', isVariantOption: false, options: [] };
  it.each([
    ['an upper-case code', { code: 'Colour' }, 'attribute-definition.code-invalid'],
    ['an unknown data type', { dataType: 'blob' }, 'attribute-definition.data-type-invalid'],
    ['no name', { names: {} }, 'attribute-definition.name-required'],
    ['a malformed locale', { names: { XX: 'A' } }, 'attribute-definition.locale-invalid'],
    ['outer spaces in a name', { names: { xx: ' A' } }, 'attribute-definition.text-invalid'],
    ['a bidi control in a name', { names: { xx: 'A‮B' } }, 'attribute-definition.text-invalid'],
    ['a select with no options', { options: [] }, 'attribute-definition.options-required'],
    [
      'options on a text attribute',
      { ...bad, options: [{ code: 'a1', labels: { xx: 'A' }, active: true, position: 0 }] },
      'attribute-definition.options-not-allowed',
    ],
    [
      'a repeated option code',
      {
        options: [
          { code: 'red', labels: { xx: 'Red' }, active: true, position: 0 },
          { code: 'red', labels: { xx: 'Red2' }, active: true, position: 1 },
        ],
      },
      'attribute-definition.option-repeated',
    ],
    [
      'an option with no label',
      { options: [{ code: 'red', labels: {}, active: true, position: 0 }] },
      'attribute-definition.option-invalid',
    ],
    [
      'a variant option that is not a select',
      { ...bad, isVariantOption: true },
      'attribute-definition.variant-option-needs-select',
    ],
    [
      'max length on a number',
      { ...bad, dataType: 'integer', bounds: { maxLength: 5 } },
      'attribute-definition.bounds-invalid',
    ],
    [
      'a fractional bound on an integer',
      { ...bad, dataType: 'integer', bounds: { min: 1.5 } },
      'attribute-definition.bounds-invalid',
    ],
    [
      'min above max',
      { ...bad, dataType: 'integer', bounds: { min: 5, max: 1 } },
      'attribute-definition.bounds-invalid',
    ],
    [
      'a zero max length',
      { ...bad, bounds: { maxLength: 0 } },
      'attribute-definition.bounds-invalid',
    ],
  ] as const)('refuses %s', (_label, overrides, code) => {
    const result = AttributeDefinition.create(input(overrides));
    expect(result.ok ? null : result.error.code).toBe(code);
  });
});
