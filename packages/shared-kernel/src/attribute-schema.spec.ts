import { validateAttributeValues } from './attribute-schema';
import type { AttributeField, AttributeSchema, AttributeValues } from './attribute-schema';
import type { Id } from './id';

const id = (text: string): Id => text as Id;

function field(overrides: Partial<AttributeField> & { code: string }): AttributeField {
  return {
    dataType: 'text',
    localizable: false,
    required: false,
    isVariantOption: false,
    material: false,
    claimChecked: true,
    bounds: {},
    ...overrides,
  };
}

function schemaOf(...fields: AttributeField[]): AttributeSchema {
  return {
    schemaRef: {
      familyCode: 'family',
      familyRevisionId: id('f'),
      definitionRevisionIds: [id('d')],
    },
    fields,
  };
}

const LOCALES = ['xx-ZZ', 'yy-ZZ'];
const check = (schema: AttributeSchema, values: AttributeValues) =>
  validateAttributeValues(schema, values, LOCALES);

describe('validateAttributeValues', () => {
  it('accepts a complete set of values of every type', () => {
    const schema = schemaOf(
      field({ code: 'name', localizable: true, required: true }),
      field({ code: 'note', dataType: 'long-text', bounds: { maxLength: 10 } }),
      field({ code: 'count', dataType: 'integer', bounds: { min: 1, max: 5 } }),
      field({ code: 'weight', dataType: 'decimal', bounds: { min: 0, max: 10 } }),
      field({ code: 'organic', dataType: 'boolean' }),
      field({
        code: 'size',
        dataType: 'select',
        bounds: { options: [{ code: 's' }, { code: 'm' }] },
      }),
      field({
        code: 'tags',
        dataType: 'multi-select',
        bounds: { options: [{ code: 'a' }, { code: 'b' }] },
      }),
      field({ code: 'bestBefore', dataType: 'date' }),
    );
    expect(
      check(schema, {
        name: { 'xx-ZZ': 'Olive oil', 'yy-ZZ': 'Huile' },
        note: 'short',
        count: 3,
        weight: '2.50',
        organic: false,
        size: 'm',
        tags: ['a', 'b'],
        bestBefore: '2028-02-29',
      }),
    ).toEqual({ ok: true, value: true });
  });

  it('requires a localizable field in the default locale only', () => {
    const schema = schemaOf(field({ code: 'name', localizable: true, required: true }));
    expect(check(schema, { name: { 'xx-ZZ': 'x' } }).ok).toBe(true);
    expect(check(schema, { name: { 'yy-ZZ': 'x' } })).toEqual({
      ok: false,
      error: [{ path: 'name.xx-ZZ', code: 'attribute.required' }],
    });
    expect(check(schema, {})).toEqual({
      ok: false,
      error: [{ path: 'name.xx-ZZ', code: 'attribute.required' }],
    });
  });

  it('refuses a locale outside the Market, a plain string for a localizable field, and an unknown code', () => {
    const schema = schemaOf(field({ code: 'name', localizable: true }));
    expect(check(schema, { name: { 'zz-ZZ': 'x' } })).toEqual({
      ok: false,
      error: [{ path: 'name', code: 'attribute.locale-unknown' }],
    });
    expect(check(schema, { name: 'x' })).toEqual({
      ok: false,
      error: [{ path: 'name', code: 'attribute.type' }],
    });
    expect(check(schema, { other: 'x' })).toEqual({
      ok: false,
      error: [{ path: '(unknown)', code: 'attribute.unknown' }],
    });
  });

  it('checks every localizable value for length and hidden characters', () => {
    const schema = schemaOf(field({ code: 'name', localizable: true, bounds: { maxLength: 3 } }));
    expect(check(schema, { name: { 'xx-ZZ': 'abcd', 'yy-ZZ': 'a​b' } })).toEqual({
      ok: false,
      error: [
        { path: 'name.xx-ZZ', code: 'attribute.too-long' },
        {
          path: 'name.yy-ZZ',
          code: 'text.invisible-character',
          offset: 1,
          character: 'other',
        },
      ],
    });
  });

  it('counts length in characters, not UTF-16 units', () => {
    const schema = schemaOf(field({ code: 'note', bounds: { maxLength: 2 } }));
    expect(check(schema, { note: '\u{1F600}\u{1F600}' }).ok).toBe(true);
  });

  it('never echoes a key the seller sent', () => {
    const schema = schemaOf(field({ code: 'name', localizable: true }));
    const result = check(schema, { '\u202E<b>x</b>': 'v', name: { '\u202Ezz': 'x' } });
    expect(JSON.stringify(result)).not.toMatch(/202E|<b>|zz/i);
    expect(result.ok).toBe(false);
  });

  it('requires a non-localizable field and treats blank as missing', () => {
    const schema = schemaOf(field({ code: 'brand', required: true }));
    for (const values of [{}, { brand: '' }, { brand: undefined }]) {
      expect(check(schema, values)).toEqual({
        ok: false,
        error: [{ path: 'brand', code: 'attribute.required' }],
      });
    }
  });

  it('reports type, range and option problems without echoing a value', () => {
    const schema = schemaOf(
      field({ code: 'count', dataType: 'integer', bounds: { min: 1, max: 5 } }),
      field({ code: 'weight', dataType: 'decimal', bounds: { max: 10 } }),
      field({ code: 'organic', dataType: 'boolean' }),
      field({ code: 'size', dataType: 'select', bounds: { options: [{ code: 's' }] } }),
      field({ code: 'tags', dataType: 'multi-select', bounds: { options: [{ code: 'a' }] } }),
      field({ code: 'when', dataType: 'date' }),
    );
    const result = check(schema, {
      count: 9,
      weight: 'heavy',
      organic: 'yes',
      size: 'xl',
      tags: ['a', 'a', 'z'],
      when: '2027-02-29',
    });
    expect(result).toEqual({
      ok: false,
      error: [
        { path: 'count', code: 'attribute.out-of-range' },
        { path: 'weight', code: 'attribute.type' },
        { path: 'organic', code: 'attribute.type' },
        { path: 'size', code: 'attribute.option-unknown' },
        { path: 'tags', code: 'attribute.option-duplicate' },
        { path: 'tags', code: 'attribute.option-unknown' },
        { path: 'when', code: 'attribute.type' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('heavy');
  });

  it('refuses a non-integer where an integer is declared, and an over-large decimal', () => {
    const schema = schemaOf(
      field({ code: 'count', dataType: 'integer' }),
      field({ code: 'weight', dataType: 'decimal', bounds: { max: 10 } }),
    );
    expect(check(schema, { count: 1.5, weight: '10.01' })).toEqual({
      ok: false,
      error: [
        { path: 'count', code: 'attribute.type' },
        { path: 'weight', code: 'attribute.out-of-range' },
      ],
    });
  });

  it('refuses every option of a select that declares none', () => {
    const schema = schemaOf(field({ code: 'size', dataType: 'select' }));
    expect(check(schema, { size: 's' }).ok).toBe(false);
  });

  it('reads only own properties of the values', () => {
    const schema = schemaOf(field({ code: 'constructor', required: true }));
    expect(check(schema, {})).toEqual({
      ok: false,
      error: [{ path: 'constructor', code: 'attribute.required' }],
    });
  });

  it('accepts values exactly at the bounds, zero, and calendar edge dates', () => {
    const schema = schemaOf(
      field({ code: 'count', dataType: 'integer', required: true, bounds: { min: 0, max: 5 } }),
      field({ code: 'weight', dataType: 'decimal', bounds: { min: 0, max: 10 } }),
      field({ code: 'when', dataType: 'date' }),
    );
    for (const when of ['2000-02-29', '2028-02-29']) {
      expect(check(schema, { count: 0, weight: '10', when }).ok).toBe(true);
    }
    expect(check(schema, { count: 5, weight: '0', when: '2027-12-31' }).ok).toBe(true);
    for (const when of ['2100-02-29', '2027-13-01', '2027-00-10', '2027-2-9']) {
      expect(check(schema, { count: 1, when }).ok).toBe(false);
    }
    for (const weight of ['01', '.5', '1e3']) {
      expect(check(schema, { count: 1, weight }).ok).toBe(false);
    }
    expect(check(schema, { count: 2 ** 53 }).ok).toBe(false);
  });

  it('refuses malformed locale maps and values of the wrong shape', () => {
    const localized = schemaOf(field({ code: 'name', localizable: true }));
    expect(check(localized, { name: { 'xx-ZZ': 5 as unknown as string } }).ok).toBe(false);
    expect(check(localized, { name: ['x'] }).ok).toBe(false);
    const plain = schemaOf(field({ code: 'name' }));
    expect(check(plain, { name: { 'xx-ZZ': 'x' } }).ok).toBe(false);
    const multi = schemaOf(
      field({
        code: 'tags',
        dataType: 'multi-select',
        required: true,
        bounds: { options: [{ code: 'a' }] },
      }),
    );
    expect(check(multi, { tags: 'a' }).ok).toBe(false);
    expect(check(multi, { tags: [] }).ok).toBe(false);
  });
});
