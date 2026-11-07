import { describe, expect, it } from 'vitest';
import type { ProductView } from './types.ts';
import { fileModelOf } from './variant-file-model.ts';
import type { TableRow } from './variants-table-logic.ts';

const product = {
  productCode: 'ZZ-000007',
  maxVariants: 100,
  variants: [
    { variantId: 'v1', state: 'published', variantCode: 'ZZ-000007-01' },
    { variantId: 'v2', state: 'retired', variantCode: 'ZZ-000007-02' },
    { variantId: 'v3', state: 'proposed', variantCode: 'ZZ-000007-03' },
  ],
  form: {
    fields: [
      {
        code: 'size',
        options: [
          { code: 'sm', labels: { 'en-AU': 'Small', 'fr-ZZ': 'Petit' } },
          { code: 'lg', labels: { 'fr-ZZ': 'Grand' } },
        ],
      },
    ],
  },
  published: {
    content: {
      variants: [
        { variantId: 'v1', optionValues: { size: 'sm' }, gtin: '00012345678905' },
        { variantId: 'v2', optionValues: { size: 'lg' }, gtin: null },
      ],
    },
  },
} as unknown as ProductView;

const rows: TableRow[] = [
  {
    variantId: 'v1',
    label: 'One',
    price: { inForce: { amount: '1500' } } as TableRow['price'],
    stock: {
      s1: { variantId: 'v1', sourceId: 's1', onHand: 3, held: 1, version: 2, retired: false },
    },
  },
];

describe('fileModelOf', () => {
  it.each([
    ['en-AU', 'Small'],
    ['fr-ZZ', 'Petit'],
  ])('builds the file model from the published revision in %s', (locale, label) => {
    const model = fileModelOf({
      product,
      rows,
      sources: [{ id: 's1', name: 'Shop' }] as never,
      currency: 'AUD',
      locale,
      canEditPrice: true,
      canEditStock: false,
    });
    expect(model).toMatchObject({
      productCode: 'ZZ-000007',
      currency: 'AUD',
      maxRows: 100,
      showPrice: true,
      showStock: true,
      canEditPrice: true,
      canEditStock: false,
      sources: [{ id: 's1', name: 'Shop' }],
    });
    expect(model.axes).toEqual([
      {
        code: 'size',
        options: [
          { code: 'sm', label },
          { code: 'lg', label: locale === 'fr-ZZ' ? 'Grand' : 'Grand' },
        ],
      },
    ]);
    expect(model.variants.map((v) => [v.variantCode, v.state, v.gtin, v.price])).toEqual([
      ['ZZ-000007-01', 'published', '00012345678905', '1500'],
      ['ZZ-000007-02', 'retired', '', null],
      ['ZZ-000007-03', 'proposed', '', null],
    ]);
    expect(model.variants[0]?.stock).toEqual({ s1: { onHand: 3 } });
  });

  it('has no price or stock columns, and no edit right on them, without the data', () => {
    const model = fileModelOf({
      product,
      rows,
      sources: [],
      currency: null,
      locale: 'en-AU',
      canEditPrice: true,
      canEditStock: true,
    });
    expect(model).toMatchObject({
      showPrice: false,
      showStock: false,
      canEditPrice: false,
      canEditStock: false,
    });
  });
});
