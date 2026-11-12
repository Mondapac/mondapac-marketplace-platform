import type { AttributeField, AttributeSchema, Id } from '@mondapac/shared-kernel';
import { simpleProductType } from '../product-types/simple';
import { attributeCodeOf, mapColumns, templateRows } from './columns';
import { checkRow, type CheckEnvironment } from './row-check';

// The `attr[<code>]` columns of the product file (attributes package A9), on two Market-like
// environments: the check reads the facts it is given, never a country.

const field = (
  code: string,
  dataType: AttributeField['dataType'],
  extra: Partial<AttributeField> = {},
): AttributeField => ({
  code,
  dataType,
  localizable: false,
  required: false,
  isVariantOption: false,
  material: false,
  claimChecked: true,
  bounds: {},
  ...extra,
});

const schemaOf = (fields: readonly AttributeField[]): AttributeSchema => ({
  schemaRef: { familyCode: 'default', familyRevisionId: 'r' as Id, definitionRevisionIds: [] },
  fields,
});

const defaultSchema = schemaOf([
  field('brand', 'text'),
  field('origin-note', 'text', { localizable: true }),
  field('servings', 'integer', { bounds: { min: 1, max: 100 } }),
  field('weight-net', 'decimal'),
  field('organic', 'boolean'),
  field('best-before', 'date'),
  field('pack-size', 'measure', {
    measure: { dimension: 'mass', units: ['g', 'kg'], defaultUnit: 'g', decimals: 1 },
  }),
  field('cut', 'select', {
    bounds: {
      options: [
        { code: 'shoulder', labels: { 'en-AU': 'Shoulder', 'en-ZZ': 'Shoulder' } },
        { code: 'leg', labels: { 'en-AU': 'Leg', 'en-ZZ': 'Leg' } },
      ],
    },
  }),
  field('diet', 'multi-select', {
    bounds: {
      options: [
        { code: 'low-fat', labels: { 'en-AU': 'Low fat', 'en-ZZ': 'Low fat' } },
        { code: 'high-protein', labels: { 'en-AU': 'High protein', 'en-ZZ': 'High protein' } },
      ],
    },
  }),
]);
const otherSchema = schemaOf([field('brand', 'text'), field('hide-grade', 'text')]);

const FIXED = [
  'Title',
  'Main category',
  'Product type',
  'Description',
  'Brand',
  'Barcode (GTIN)',
  'Unit size',
  'Image URL',
  'Tax category',
];

function envOf(locale: string): CheckEnvironment {
  return {
    defaultLocale: locale,
    locales: [locale],
    categoriesByName: new Map([
      ['meat', ['cat_meat']],
      ['hides', ['cat_hides']],
      ['lost', ['cat_lost']],
    ]),
    categoriesBySlug: new Map(),
    typesOffered: ['simple'],
    handlerFor: () => simpleProductType,
    schema: defaultSchema,
    schemaByCategory: new Map([
      ['cat_meat', defaultSchema],
      ['cat_hides', otherSchema],
      ['cat_lost', null],
    ]),
    taxCategoryCodes: ['standard'],
  };
}

function checkWith(
  attributeHeaders: readonly string[],
  cells: readonly string[],
  locale: string,
  category = 'Meat',
) {
  const header = [...FIXED, ...attributeHeaders];
  const mapped = mapColumns(header);
  if (!mapped.ok) throw new Error('columns');
  const row = {
    rowNumber: 2,
    cells: ['Lamb', category, 'simple', '', 'Farms', '', '', '', '', ...cells],
  };
  return checkRow(row, mapped.value.map, envOf(locale), mapped.value.attributes);
}

describe('attributeCodeOf and mapColumns', () => {
  it('reads attr[<code>] headers without regard to case or spacing', () => {
    expect(attributeCodeOf('attr[pack-size]')).toBe('pack-size');
    expect(attributeCodeOf('  ATTR [ Pack-Size ] ')).toBe('pack-size');
    expect(attributeCodeOf('attr[]')).toBeNull();
    expect(attributeCodeOf('attr[Pack Size]')).toBeNull();
    expect(attributeCodeOf('Title')).toBeNull();
  });

  it('never reads a certification-looking code as an attribute column', () => {
    expect(attributeCodeOf('attr[halal-status]')).toBeNull();
    const mapped = mapColumns([...FIXED, 'attr[halal-status]', 'attr[cut]']);
    expect(mapped.ok && [...mapped.value.attributes.keys()]).toEqual(['cut']);
    expect(mapped.ok && mapped.value.ignored).toEqual([
      { header: 'attr[halal-status]', certification: true },
    ]);
  });

  it('refuses an attribute column that appears twice', () => {
    const mapped = mapColumns([...FIXED, 'attr[cut]', 'ATTR[cut]']);
    expect(mapped).toEqual({
      ok: false,
      error: { code: 'columns.duplicate', columns: ['attr[cut]'] },
    });
  });

  it('adds the attribute columns to the template', () => {
    const rows = templateRows('simple', ['cut', 'pack-size']);
    expect(rows[0]!.slice(-2)).toEqual(['attr[cut]', 'attr[pack-size]']);
    expect(rows[1]).toHaveLength(rows[0]!.length);
  });
});

describe.each([
  ['AU', 'en-AU'],
  ['ZZ', 'en-ZZ'],
] as const)('checkRow with attribute columns in market %s', (_code, locale) => {
  it('stores each type the way the schema wants it', () => {
    const row = checkWith(
      [
        'attr[servings]',
        'attr[weight-net]',
        'attr[organic]',
        'attr[best-before]',
        'attr[pack-size]',
        'attr[cut]',
        'attr[diet]',
        'attr[origin-note]',
      ],
      ['4', '1.25', 'Yes', '2026-12-31', '500 g', 'shoulder', 'Low fat; high-protein', 'Local'],
      locale,
    );
    expect(row.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(row.state).toBe('ready');
    expect(row.plan?.content['attributeValues']).toEqual({
      brand: 'Farms',
      servings: 4,
      'weight-net': '1.25',
      organic: true,
      'best-before': '2026-12-31',
      'pack-size': { value: '500', unit: 'g' },
      cut: 'shoulder',
      diet: ['low-fat', 'high-protein'],
      'origin-note': { [locale]: 'Local' },
    });
  });

  it('takes a select option by its English label, in any case', () => {
    const row = checkWith(['attr[cut]'], ['  LEG '], locale);
    expect(row.plan?.content['attributeValues']).toMatchObject({ cut: 'leg' });
  });

  it('uses the default unit of a measure given as a bare number, and matches the unit loosely', () => {
    expect(
      checkWith(['attr[pack-size]'], ['250'], locale).plan?.content['attributeValues'],
    ).toMatchObject({ 'pack-size': { value: '250', unit: 'g' } });
    expect(
      checkWith(['attr[pack-size]'], ['1.5 KG'], locale).plan?.content['attributeValues'],
    ).toMatchObject({ 'pack-size': { value: '1500', unit: 'kg' } });
  });

  it('reports a bad cell on its own attribute column', () => {
    const row = checkWith(
      [
        'attr[servings]',
        'attr[organic]',
        'attr[cut]',
        'attr[diet]',
        'attr[pack-size]',
        'attr[best-before]',
      ],
      ['many', 'maybe', 'neck', 'low fat; Low-fat', '5 stone', '31/12/2026'],
      locale,
    );
    expect(row.state).toBe('error');
    expect(row.plan).toBeNull();
    expect(
      row.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => `${issue.column}:${issue.code}`),
    ).toEqual([
      'attr[servings]:attribute.type',
      'attr[organic]:attribute.type',
      'attr[cut]:attribute.option-unknown',
      'attr[diet]:attribute.option-duplicate',
      'attr[pack-size]:attribute.unit-unknown',
      'attr[best-before]:attribute.type',
    ]);
  });

  it('lets the schema refuse a value out of range, on the attribute column', () => {
    const row = checkWith(['attr[servings]'], ['500'], locale);
    expect(row.issues.filter((issue) => issue.severity === 'error')).toEqual([
      expect.objectContaining({
        severity: 'error',
        column: 'attr[servings]',
        code: 'attribute.out-of-range',
      }),
    ]);
  });

  it('warns about a column the feature set does not have, and about one a dedicated column filled', () => {
    const row = checkWith(['attr[hide-grade]', 'attr[brand]'], ['A', 'Other'], locale);
    expect(row.state).toBe('ready');
    expect(row.issues.map((issue) => `${issue.severity}:${issue.column}:${issue.code}`)).toEqual(
      expect.arrayContaining([
        'warning:attr[hide-grade]:column.not-stored',
        'warning:attr[brand]:column.not-stored',
      ]),
    );
    expect(row.plan?.content['attributeValues']).toEqual({ brand: 'Farms' });
  });

  it('checks a row against the feature set of its own category', () => {
    const hides = checkWith(['attr[hide-grade]'], ['A'], locale, 'Hides');
    expect(hides.state).toBe('ready');
    expect(hides.plan?.content['attributeValues']).toEqual({ brand: 'Farms', 'hide-grade': 'A' });
    const meat = checkWith(['attr[hide-grade]'], ['A'], locale, 'Meat');
    expect(meat.issues.map((issue) => issue.code)).toContain('column.not-stored');
  });

  it('refuses a row whose category has a feature set that cannot be read', () => {
    const row = checkWith([], [], locale, 'Lost');
    expect(row.state).toBe('error');
    expect(row.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'category', code: 'family.unavailable' }),
      ]),
    );
  });

  it('refuses a control character in an attribute cell, naming its column', () => {
    const row = checkWith(['attr[origin-note]'], ['bad\u0001text'], locale);
    expect(row.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'attr[origin-note]', code: 'text.invalid-characters' }),
      ]),
    );
  });
});
