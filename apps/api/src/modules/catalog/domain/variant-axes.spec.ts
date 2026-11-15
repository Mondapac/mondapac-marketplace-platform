import type { AttributeSchema, Id } from '@mondapac/shared-kernel';
import { axisCandidates, chooseAxes } from './variant-axes';

const select = (code: string, isVariantOption: boolean) => ({
  code,
  dataType: 'select' as const,
  localizable: false,
  required: false,
  isVariantOption,
  material: false,
  claimChecked: false,
  bounds: { options: [{ code: 'a', labels: { en: 'A' } }] },
});

const schema = {
  schemaRef: { familyCode: 'f', familyRevisionId: 'r' as Id, definitionRevisionIds: [] },
  fields: [select('size', true), select('colour', true), select('material', false)],
} as unknown as AttributeSchema;

describe('chooseAxes', () => {
  it('lists the variant attributes of the feature set as candidates', () => {
    expect(axisCandidates(schema)).toEqual(['size', 'colour']);
  });

  it('keeps every candidate when the draft names no axes', () => {
    const result = chooseAxes(schema, undefined, 2, null);
    expect(result.ok && result.codes).toEqual(['size', 'colour']);
  });

  it('keeps the feature set order and drops the unchosen candidate from the schema', () => {
    const result = chooseAxes(schema, ['colour'], 2, null);
    expect(result.ok && result.codes).toEqual(['colour']);
    expect(
      result.ok && result.schema.fields.filter((f) => f.isVariantOption).map((f) => f.code),
    ).toEqual(['colour']);
    expect(result.ok && result.schema.fields.some((f) => f.code === 'size')).toBe(false);
    expect(result.ok && result.schema.fields.some((f) => f.code === 'material')).toBe(true);
  });

  it.each([
    [[], 'variants.axes-none'],
    [['size', 'size'], 'variants.axes-duplicate'],
    [['weight'], 'variants.axes-unknown'],
    [['material'], 'variants.axes-unknown'],
    [['size', 'colour'], 'variants.axes-too-many'],
  ])('refuses %j with %s', (requested, code) => {
    const result = chooseAxes(schema, requested, code === 'variants.axes-too-many' ? 1 : 2, null);
    expect(!result.ok && result.issues.map((issue) => issue.code)).toContain(code);
  });

  it('refuses a different set once the axes are locked, in any order', () => {
    const changed = chooseAxes(schema, ['colour'], 2, ['size']);
    expect(!changed.ok && changed.issues).toEqual([
      { path: 'variantAxes', code: 'variants.axes-locked' },
    ]);
    expect(chooseAxes(schema, ['colour', 'size'], 2, ['size', 'colour']).ok).toBe(true);
    expect(chooseAxes(schema, undefined, 2, ['size', 'colour']).ok).toBe(true);
  });

  it('keeps the published axes when the draft names none (a product on part of its candidates)', () => {
    const result = chooseAxes(schema, undefined, 2, ['size']);
    expect(result.ok && result.codes).toEqual(['size']);
  });
});

describe('chooseAxes: add a second axis (variants V9b)', () => {
  const three = {
    ...schema,
    fields: [...schema.fields, select('flavour', true)],
  } as unknown as AttributeSchema;
  const refused = (result: ReturnType<typeof chooseAxes>) => !result.ok && result.issues;

  it('accepts the locked axis plus exactly one more when two axes are allowed', () => {
    const result = chooseAxes(schema, ['size', 'colour'], 2, ['size']);
    expect(result.ok && result.codes).toEqual(['size', 'colour']);
    expect(
      result.ok && result.schema.fields.filter((f) => f.isVariantOption).map((f) => f.code),
    ).toEqual(['size', 'colour']);
    // The order of the request does not matter.
    expect(chooseAxes(schema, ['colour', 'size'], 2, ['size']).ok).toBe(true);
    expect(chooseAxes(schema, ['colour', 'size'], 2, ['colour']).ok).toBe(true);
  });

  it('refuses it when the Market allows one axis only', () => {
    expect(refused(chooseAxes(schema, ['size', 'colour'], 1, ['size']))).toEqual([
      { path: 'variantAxes', code: 'variants.axes-too-many' },
      { path: 'variantAxes', code: 'variants.axes-locked' },
    ]);
  });

  it('refuses a third axis for a product on two', () => {
    expect(
      refused(chooseAxes(three, ['size', 'colour', 'flavour'], 3, ['size', 'colour'])),
    ).toEqual([{ path: 'variantAxes', code: 'variants.axes-locked' }]);
  });

  it('refuses two more axes for a product on one', () => {
    expect(refused(chooseAxes(three, ['size', 'colour', 'flavour'], 3, ['size']))).toEqual([
      { path: 'variantAxes', code: 'variants.axes-locked' },
    ]);
  });

  it('refuses a set that drops a locked axis, from one or two', () => {
    expect(refused(chooseAxes(three, ['colour', 'flavour'], 2, ['size']))).toEqual([
      { path: 'variantAxes', code: 'variants.axes-locked' },
    ]);
    expect(refused(chooseAxes(three, ['colour'], 2, ['size', 'colour']))).toEqual([
      { path: 'variantAxes', code: 'variants.axes-locked' },
    ]);
  });

  it('refuses a swap', () => {
    expect(refused(chooseAxes(schema, ['colour'], 2, ['size']))).toEqual([
      { path: 'variantAxes', code: 'variants.axes-locked' },
    ]);
    expect(refused(chooseAxes(three, ['colour', 'flavour'], 2, ['size', 'colour']))).toEqual([
      { path: 'variantAxes', code: 'variants.axes-locked' },
    ]);
  });
});
