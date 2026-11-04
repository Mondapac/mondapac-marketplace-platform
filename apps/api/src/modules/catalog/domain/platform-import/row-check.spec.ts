import type { AttributeField, AttributeSchema, Id } from '@mondapac/shared-kernel';
import { configurableProductType } from '../product-types/configurable';
import { simpleProductType } from '../product-types/simple';
import { mapColumns } from './columns';
import {
  checkRow,
  countRows,
  gtinCheckDigitValid,
  markDuplicates,
  type CheckEnvironment,
} from './row-check';

// The row check on two Market-like environments (AU with GST, ZZ synthetic): the check reads the
// facts it is given, never a country.

const text = (code: string, required: boolean, localizable: boolean): AttributeField => ({
  code,
  dataType: 'text',
  localizable,
  required,
  isVariantOption: false,
  material: false,
  claimChecked: true,
  bounds: {},
});

const schema: AttributeSchema = {
  schemaRef: { familyCode: 'default', familyRevisionId: 'r' as Id, definitionRevisionIds: [] },
  fields: [text('brand', true, false), text('description', false, true)],
};

const handlers = { simple: simpleProductType, configurable: configurableProductType };

function envOf(locale: string, taxCodes: readonly string[]): CheckEnvironment {
  return {
    defaultLocale: locale,
    locales: [locale],
    categoriesByName: new Map([
      ['meat', ['cat_meat']],
      ['twin', ['a', 'b']],
    ]),
    categoriesBySlug: new Map([['meat', 'cat_meat']]),
    typesOffered: ['simple', 'configurable'],
    handlerFor: (code) => handlers[code as keyof typeof handlers],
    schema,
    taxCategoryCodes: taxCodes,
  };
}

const HEADER = [
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
const mapped = mapColumns(HEADER);
if (!mapped.ok) throw new Error('columns');
const map = mapped.value.map;
const rowOf = (rowNumber: number, cells: Partial<Record<number, string>>) => ({
  rowNumber,
  cells: HEADER.map((_, index) => cells[index] ?? ''),
});

describe.each([
  ['AU', 'en-AU', ['taxable', 'gst_free']],
  ['ZZ', 'en-ZZ', ['standard']],
] as const)('checkRow in market %s', (_code, locale, taxCodes) => {
  const env = envOf(locale, taxCodes);

  it('turns a good row into a plan with the default tax category and a warning', () => {
    const row = checkRow(
      rowOf(2, { 0: 'Lamb', 1: 'Meat', 2: 'Simple', 3: 'Shoulder', 4: 'Farms' }),
      map,
      env,
    );
    expect(row.state).toBe('ready');
    expect(row.plan).toMatchObject({
      typeCode: 'simple',
      content: {
        texts: { [locale]: { name: 'Lamb', description: 'Shoulder' } },
        categoryIds: ['cat_meat'],
        taxCategoryCode: taxCodes[0],
        imageIds: [],
      },
    });
    expect(row.issues.map((issue) => issue.code)).toContain('tax-category.default-used');
  });

  it('reports each problem with its column and keeps the plan empty', () => {
    const row = checkRow(rowOf(5, { 1: 'Nowhere', 2: 'Fresh meat' }), map, env);
    expect(row.state).toBe('error');
    expect(row.plan).toBeNull();
    const codes = row.issues.map((issue) => `${issue.column}:${issue.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'title:required',
        'category:category.unknown',
        'type:product-type.unknown',
      ]),
    );
  });

  it('refuses an ambiguous category and a type that needs variants', () => {
    const row = checkRow(rowOf(2, { 0: 'X', 1: 'Twin', 2: 'configurable', 4: 'B' }), map, env);
    const codes = row.issues.map((issue) => issue.code);
    expect(codes).toContain('category.ambiguous');
    expect(codes).toContain('product-type.needs-variants');
  });

  it('requires the family brand through the schema', () => {
    const row = checkRow(rowOf(2, { 0: 'X', 1: 'Meat', 2: 'simple' }), map, env);
    expect(row.state).toBe('error');
    expect(row.issues.some((issue) => issue.column === 'brand')).toBe(true);
  });

  it('checks the barcode length and check digit, and the image link scheme', () => {
    const base = { 0: 'X', 1: 'Meat', 2: 'simple', 4: 'B' };
    const codesOf = (cells: Partial<Record<number, string>>) =>
      checkRow(rowOf(2, cells), map, env).issues.map((issue) => issue.code);
    expect(codesOf({ ...base, 5: '123' })).toContain('gtin.length');
    expect(codesOf({ ...base, 5: '9780306406158' })).toContain('gtin.check-digit');
    expect(checkRow(rowOf(2, { ...base, 7: 'http://x.test/a.jpg' }), map, env).state).toBe('error');
    const good = checkRow(rowOf(2, { ...base, 7: 'https://x.test/a.jpg' }), map, env);
    expect(good.state).toBe('ready');
    expect(good.issues.map((issue) => issue.code)).toContain('image-url.not-fetched');
  });

  it('stores nothing about certification: the plan has no handling, tags or attestations', () => {
    const row = checkRow(rowOf(2, { 0: 'X', 1: 'Meat', 2: 'simple', 4: 'B' }), map, env);
    expect(Object.keys(row.plan!.content).sort()).toEqual([
      'attributeValues',
      'categoryIds',
      'imageIds',
      'taxCategoryCode',
      'texts',
    ]);
  });

  it('refuses control characters', () => {
    const row = checkRow(rowOf(2, { 0: 'X\u0000', 1: 'Meat', 2: 'simple', 4: 'B' }), map, env);
    expect(row.issues.map((issue) => issue.code)).toContain('text.invalid-characters');
  });
});

describe('markDuplicates and countRows', () => {
  const env = envOf('en-AU', ['taxable']);
  it('marks the later row of the same title and brand and counts the tiles', () => {
    const rows = markDuplicates([
      checkRow(rowOf(2, { 0: 'Lamb', 1: 'Meat', 2: 'simple', 4: 'B' }), map, env),
      checkRow(rowOf(3, { 0: ' lamb ', 1: 'Meat', 2: 'simple', 4: 'b' }), map, env),
      checkRow(rowOf(4, { 0: 'Beef', 1: 'Meat', 2: 'simple', 4: 'B' }), map, env),
    ]);
    expect(rows[1]!.state).toBe('error');
    expect(rows[1]!.issues.at(-1)).toMatchObject({ code: 'duplicate-in-file', otherRow: 2 });
    expect(countRows(rows)).toMatchObject({ rows: 3, ready: 2, errors: 1 });
  });
});

describe('gtinCheckDigitValid', () => {
  it('accepts valid and refuses invalid check digits', () => {
    expect(gtinCheckDigitValid('9780306406157')).toBe(true);
    expect(gtinCheckDigitValid('9780306406158')).toBe(false);
  });
});
