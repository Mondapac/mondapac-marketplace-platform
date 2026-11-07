import type { AttributeField, AttributeSchema, Id } from '@mondapac/shared-kernel';
import { configurableProductType } from '../product-types/configurable';
import { simpleProductType } from '../product-types/simple';
import { mapSellerColumns, type SellerImportMode } from './columns';
import { mergeImportRow, withMintedIds, placeholderOf } from './merge-import-row';
import {
  attributeColumnCodes,
  checkSellerFile,
  countSellerRows,
  optionColumnCodes,
  type SellerCheckEnvironment,
  type SellerCheckFacts,
} from './row-check';

// The seller import's header map, group check and merge on two Market-like environments (AU with
// GST, ZZ synthetic): they read the facts they are given, never a country.

const text = (code: string, required: boolean): AttributeField => ({
  code,
  dataType: 'text',
  localizable: false,
  required,
  isVariantOption: false,
  material: false,
  claimChecked: true,
  bounds: {},
});

const option = (code: string, values: readonly string[]): AttributeField => ({
  code,
  dataType: 'select',
  localizable: false,
  required: false,
  isVariantOption: true,
  material: false,
  claimChecked: true,
  bounds: { options: values.map((value) => ({ code: value, labels: { 'en-AU': value, 'en-ZZ': value } })) },
});

const schema: AttributeSchema = {
  schemaRef: { familyCode: 'default', familyRevisionId: 'r' as Id, definitionRevisionIds: [] },
  fields: [
    text('brand', false),
    option('size', ['s', 'm', 'l']),
    option('colour', ['red', 'blue']),
  ],
};
const handlers = { simple: simpleProductType, configurable: configurableProductType };

function envOf(locale: string, taxCodes: readonly string[]): SellerCheckEnvironment {
  return {
    defaultLocale: locale,
    locales: [locale],
    categoriesByName: new Map([['meat', ['cat_meat']]]),
    categoriesBySlug: new Map([['meat', 'cat_meat']]),
    typesOffered: ['simple', 'configurable'],
    handlerFor: (code) => handlers[code as keyof typeof handlers],
    schema,
    taxCategoryCodes: taxCodes,
    conditions: ['new', 'used'],
    maxVariantsPerProduct: 3,
    maxVariantAttributes: 2,
    allowedTypes: 'all',
  };
}

const EMPTY_FACTS: SellerCheckFacts = {
  offersBySku: new Map(),
  ownSkuByProductId: new Map(),
  catalogueByCode: new Map(),
};

const MINE_HEADER = [
  'Seller SKU',
  'Condition',
  'Title',
  'Main category',
  'Product type',
  'Option[size]',
  'Option[colour]',
  'Certification',
  'Price',
  'Stock',
];

function mapOf(env: SellerCheckEnvironment, header: readonly string[], mode: SellerImportMode) {
  const mapped = mapSellerColumns(header, mode, {
    optionCodes: optionColumnCodes(env),
    attributeCodes: attributeColumnCodes(env),
  });
  if (!mapped.ok) throw new Error(mapped.error.code);
  return mapped.value;
}

const rowOf = (
  header: readonly string[],
  rowNumber: number,
  cells: Readonly<Record<string, string>>,
) => ({
  rowNumber,
  // A new Offer needs a condition; every row repeats it, as the cells of one group must.
  cells: header.map((name) => ({ Condition: 'New', ...cells })[name] ?? ''),
});

describe('mapSellerColumns', () => {
  const env = envOf('en-AU', ['taxable']);

  it('lists certification, price and stock columns as ignored with their marks and never maps them', () => {
    const map = mapOf(env, MINE_HEADER, 'my-products');
    expect(map.ignored).toEqual([
      { header: 'Certification', mark: 'certification' },
      { header: 'Price', mark: 'elsewhere' },
      { header: 'Stock', mark: 'elsewhere' },
    ]);
    expect(Object.keys(map.fixed)).not.toContain('price');
    expect(map.options.map((column) => column.code)).toEqual(['size', 'colour']);
  });

  it('treats an Option[...] column of an unknown code as ignored, never as a new attribute', () => {
    const map = mapOf(env, [...MINE_HEADER, 'Option[flavour]'], 'my-products');
    expect(map.options.map((column) => column.code)).not.toContain('flavour');
    expect(map.ignored.map((column) => column.header)).toContain('Option[flavour]');
  });

  it('refuses a file without the required columns of its mode, and a repeated column', () => {
    const missing = mapSellerColumns(['Seller SKU'], 'my-products', {
      optionCodes: new Set(),
      attributeCodes: new Set(),
    });
    expect(missing).toMatchObject({ ok: false, error: { code: 'columns.missing' } });
    const twice = mapSellerColumns(['Seller SKU', 'SKU', 'Product code'], 'sell-from-catalogue', {
      optionCodes: new Set(),
      attributeCodes: new Set(),
    });
    expect(twice).toMatchObject({ ok: false, error: { code: 'columns.duplicate' } });
  });
});

describe.each([
  ['AU', 'en-AU', ['taxable', 'gst_free']],
  ['ZZ', 'en-ZZ', ['standard']],
] as const)('checkSellerFile in market %s', (_code, locale, taxCodes) => {
  const env = envOf(locale, taxCodes);
  const map = mapOf(env, MINE_HEADER, 'my-products');
  const row = (n: number, cells: Readonly<Record<string, string>>) => rowOf(MINE_HEADER, n, cells);

  it('turns a Simple product row into a create plan with no certification, price or stock field', () => {
    const groups = checkSellerFile(
      [
        row(2, {
          'Seller SKU': 'LAMB-1',
          Title: 'Lamb',
          'Main category': 'Meat',
          'Product type': 'simple',
          Certification: 'Halal',
          Price: '12.50',
          Stock: '4',
        }),
      ],
      map,
      env,
      EMPTY_FACTS,
    );
    expect(groups).toHaveLength(1);
    const plan = groups[0]!.plan!;
    expect(plan.kind).toBe('create');
    expect(plan.product).toMatchObject({ typeCode: 'simple', title: 'Lamb' });
    expect(JSON.stringify(plan)).not.toMatch(/halal|12\.5|price|stock|certification/i);
  });

  it('groups the rows of one Seller SKU into one Configurable product with two axes', () => {
    const groups = checkSellerFile(
      [
        row(2, {
          'Seller SKU': 'TEE',
          Title: 'Tee',
          'Main category': 'Meat',
          'Product type': 'configurable',
          'Option[size]': 'S',
          'Option[colour]': 'Red',
        }),
        row(3, { 'Seller SKU': 'TEE', 'Option[size]': 'M', 'Option[colour]': 'Blue' }),
      ],
      map,
      env,
      EMPTY_FACTS,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((r) => r.state)).toEqual(['ready', 'ready']);
    const plan = groups[0]!.plan!;
    expect(plan.product!.axes).toEqual(['size', 'colour']);
    expect(plan.variants.map((variant) => variant.optionKey)).toEqual([
      'colour=red;size=s',
      'colour=blue;size=m',
    ]);
  });

  it('fails the whole group when one row is bad, and the other rows say so', () => {
    const groups = checkSellerFile(
      [
        row(2, {
          'Seller SKU': 'TEE',
          Title: 'Tee',
          'Main category': 'Meat',
          'Product type': 'configurable',
          'Option[size]': 'S',
          'Option[colour]': 'Red',
        }),
        row(3, { 'Seller SKU': 'TEE', 'Option[size]': 'XXL', 'Option[colour]': 'Blue' }),
      ],
      map,
      env,
      EMPTY_FACTS,
    );
    expect(groups[0]!.plan).toBeNull();
    expect(groups[0]!.rows.map((r) => r.state)).toEqual(['error', 'error']);
    expect(groups[0]!.rows[0]!.issues.map((issue) => issue.code)).toContain('import.group-error');
  });

  it('refuses a repeated option combination and a split group', () => {
    const groups = checkSellerFile(
      [
        row(2, {
          'Seller SKU': 'TEE',
          Title: 'Tee',
          'Main category': 'Meat',
          'Product type': 'configurable',
          'Option[size]': 'S',
          'Option[colour]': 'Red',
        }),
        row(3, { 'Seller SKU': 'TEE', 'Option[size]': 'S', 'Option[colour]': 'Red' }),
        row(4, {
          'Seller SKU': 'OTHER',
          Title: 'Other',
          'Main category': 'Meat',
          'Product type': 'simple',
        }),
        row(5, { 'Seller SKU': 'TEE', 'Option[size]': 'M', 'Option[colour]': 'Red' }),
      ],
      map,
      env,
      EMPTY_FACTS,
    );
    const codes = groups.flatMap((group) => group.rows.flatMap((r) => r.issues.map((i) => i.code)));
    expect(codes).toContain('import.duplicate-row');
    expect(codes).toContain('import.group-split');
    expect(countSellerRows(groups).groups).toBe(3);
  });

  it('refuses a fourth variant over the Market limit', () => {
    const rows = [
      row(2, {
        'Seller SKU': 'TEE',
        Title: 'Tee',
        'Main category': 'Meat',
        'Product type': 'configurable',
        'Option[size]': 'S',
        'Option[colour]': 'Red',
      }),
      row(3, { 'Seller SKU': 'TEE', 'Option[size]': 'M', 'Option[colour]': 'Red' }),
      row(4, { 'Seller SKU': 'TEE', 'Option[size]': 'L', 'Option[colour]': 'Red' }),
      row(5, { 'Seller SKU': 'TEE', 'Option[size]': 'S', 'Option[colour]': 'Blue' }),
    ];
    const groups = checkSellerFile(rows, map, env, EMPTY_FACTS);
    const codes = groups[0]!.rows.flatMap((r) => r.issues.map((i) => i.code));
    expect(codes).toContain('variant.limit-reached');
    expect(groups[0]!.plan).toBeNull();
  });

  it('refuses a product type the seller may not sell (SEL-12)', () => {
    const restricted: SellerCheckEnvironment = { ...env, allowedTypes: new Set(['simple']) };
    const groups = checkSellerFile(
      [
        row(2, {
          'Seller SKU': 'TEE',
          Title: 'Tee',
          'Main category': 'Meat',
          'Product type': 'configurable',
          'Option[size]': 'S',
          'Option[colour]': 'Red',
        }),
      ],
      mapOf(restricted, MINE_HEADER, 'my-products'),
      restricted,
      EMPTY_FACTS,
    );
    expect(groups[0]!.rows[0]!.issues.map((i) => i.code)).toContain('type.not-allowed');
  });
});

describe('sell-from-catalogue', () => {
  const env = envOf('en-AU', ['taxable']);
  const header = ['Seller SKU', 'Product code', 'Condition'];
  const map = mapOf(env, header, 'sell-from-catalogue');
  const facts: SellerCheckFacts = {
    offersBySku: new Map(),
    ownSkuByProductId: new Map([['p-own', 'MINE']]),
    catalogueByCode: new Map([
      ['P-1', { productId: 'p-1', typeCode: 'simple' }],
      ['P-OWN', { productId: 'p-own', typeCode: 'simple' }],
    ]),
  };

  it('answers an unknown code, a paused code and a retired code with the same product.not-found', () => {
    const groups = checkSellerFile(
      [
        rowOf(header, 2, { 'Seller SKU': 'A', 'Product code': 'P-NOPE' }),
        rowOf(header, 3, { 'Seller SKU': 'B', 'Product code': 'P-PAUSED' }),
      ],
      map,
      env,
      facts,
    );
    const answers = groups.map((group) => group.rows[0]!.issues.map((i) => `${i.column}:${i.code}`));
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toContain('productCode:product.not-found');
  });

  it('creates an Offer on an eligible product and refuses a second Offer on a product already sold', () => {
    const groups = checkSellerFile(
      [
        rowOf(header, 2, { 'Seller SKU': 'A', 'Product code': 'P-1' }),
        rowOf(header, 3, { 'Seller SKU': 'B', 'Product code': 'P-OWN' }),
      ],
      map,
      env,
      facts,
    );
    expect(groups[0]!.plan).toMatchObject({ kind: 'create', catalogueProduct: { productId: 'p-1' } });
    expect(groups[1]!.rows[0]!.issues.map((i) => i.code)).toContain('offer.exists-for-product');
  });

  it('marks a repeated SKU or product code in the file against the first row', () => {
    const groups = checkSellerFile(
      [
        rowOf(header, 2, { 'Seller SKU': 'A', 'Product code': 'P-1' }),
        rowOf(header, 3, { 'Seller SKU': 'A', 'Product code': 'P-1' }),
      ],
      map,
      env,
      facts,
    );
    expect(groups[1]!.rows[0]!.state).toBe('error');
    expect(groups[1]!.rows[0]!.issues.some((i) => i.otherRow === 2)).toBe(true);
  });
});

describe('mergeImportRow', () => {
  const env = envOf('en-AU', ['taxable']);
  const map = mapOf(env, MINE_HEADER, 'my-products');
  const planOf = (cells: readonly Readonly<Record<string, string>>[], facts = EMPTY_FACTS) => {
    const rows = cells.map((c, index) => rowOf(MINE_HEADER, index + 2, c));
    return checkSellerFile(rows, map, env, facts)[0]!.plan!;
  };

  it('keeps a stored value when the cell is empty and replaces it when it is given', () => {
    const plan = planOf([
      { 'Seller SKU': 'LAMB', Title: 'New title', 'Main category': 'Meat', 'Product type': 'simple' },
    ]);
    const base = {
      content: { texts: { 'en-AU': { name: 'Old', description: 'Kept' } }, imageIds: ['img1'] },
      liveVariantIds: ['v1'],
    };
    const merged = mergeImportRow(base, plan, { defaultLocale: 'en-AU' });
    expect(merged.content['texts']).toEqual({ 'en-AU': { name: 'New title', description: 'Kept' } });
    expect(merged.content['imageIds']).toEqual(['img1']);
    expect(merged.variantIds).toEqual(['v1']);
  });

  it('says unchanged when the plan changes nothing', () => {
    const plan = planOf([
      { 'Seller SKU': 'LAMB', Title: 'Same', 'Main category': 'Meat', 'Product type': 'simple' },
    ]);
    const first = mergeImportRow({ content: {}, liveVariantIds: ['v1'] }, plan, {
      defaultLocale: 'en-AU',
    });
    const again = mergeImportRow(
      { content: first.content, liveVariantIds: ['v1'] },
      plan,
      { defaultLocale: 'en-AU' },
    );
    expect(first.changed).toBe(true);
    expect(again.changed).toBe(false);
  });

  it('appends a new variant with a placeholder id and later swaps in the minted id', () => {
    const plan = planOf([
      {
        'Seller SKU': 'TEE',
        Title: 'Tee',
        'Main category': 'Meat',
        'Product type': 'configurable',
        'Option[size]': 'S',
        'Option[colour]': 'Red',
      },
      { 'Seller SKU': 'TEE', 'Option[size]': 'M', 'Option[colour]': 'Red' },
    ]);
    const merged = mergeImportRow({ content: {}, liveVariantIds: [] }, plan, {
      defaultLocale: 'en-AU',
    });
    expect(merged.variantIds).toEqual([null, null]);
    expect(merged.placeholders).toEqual([placeholderOf(2), placeholderOf(3)]);
    const swapped = withMintedIds(merged.content, merged.placeholders, ['va', 'vb']);
    expect((swapped['variants'] as { variantId: string }[]).map((v) => v.variantId)).toEqual([
      'va',
      'vb',
    ]);
  });
});
