import { describe, expect, it } from 'vitest';
import {
  exportVariantFile,
  FILE_LIMITS,
  labelKey,
  readVariantFile,
  type FileModel,
  type FileVariant,
  type ImportPreview,
} from './variant-file.ts';

// The variant file (catalog design 14b), against two Market fixtures: AU (two decimals, English
// labels) and a synthetic one (no decimals, labels with accents, spaces and a leading minus).

interface Fixture {
  readonly name: string;
  readonly currency: string;
  readonly colour: [string, string, string];
  readonly size: [string, string];
  readonly price: [string, string];
  readonly priceText: [string, string];
}
const FIXTURES: readonly Fixture[] = [
  {
    name: 'AU',
    currency: 'AUD',
    colour: ['Red', 'Blue', 'Green'],
    size: ['Small', 'Large'],
    price: ['1999', '2500'],
    priceText: ['19.99', '25.00'],
  },
  {
    name: 'ZZ',
    currency: 'JPY',
    colour: ['Rouge foncé', '-Bleu', 'Vert'],
    size: ['Petit  taille', 'Grand'],
    price: ['1999', '2500'],
    priceText: ['1999', '2500'],
  },
];

const bytes = (text: string) => new TextEncoder().encode(text);

function modelOf(fixture: Fixture, over: Partial<FileModel> = {}): FileModel {
  const variant = (
    n: number,
    colour: string,
    size: string,
    extra: Partial<FileVariant> = {},
  ): FileVariant => ({
    variantId: `v${n}`,
    variantCode: `P-000001-0${n}`,
    state: 'published',
    options: { colour, size },
    gtin: n === 1 ? '00012345678905' : '',
    variantSku: n === 1 ? 'RED-S' : '',
    selling: true,
    price: fixture.price[0],
    stock: { s1: { onHand: 10 }, s2: { onHand: 4 } },
    ...extra,
  });
  return {
    productCode: 'P-000001',
    currency: fixture.currency,
    axes: [
      {
        code: 'colour',
        options: [
          { code: 'red', label: fixture.colour[0] },
          { code: 'blue', label: fixture.colour[1] },
          { code: 'green', label: fixture.colour[2] },
        ],
      },
      {
        code: 'size',
        options: [
          { code: 'sm', label: fixture.size[0] },
          { code: 'lg', label: fixture.size[1] },
        ],
      },
    ],
    variants: [
      variant(1, 'red', 'sm'),
      variant(2, 'blue', 'lg', { price: fixture.price[1] }),
      variant(3, 'green', 'sm', { state: 'retired' }),
    ],
    sources: [
      { id: 's1', name: 'Brisbane shop' },
      { id: 's2', name: 'Warehouse' },
    ],
    showPrice: true,
    showStock: true,
    canEditPrice: true,
    canEditStock: true,
    canEditSellUnits: true,
    maxRows: 100,
    ...over,
  };
}

/**
 * The exported file with the rows replaced by hand-made ones (header kept). The rows are edited
 * in the layout without `variant_sku` and `selling` (the blank cells for them are put back after
 * `gtin`), so a row of these tests leaves the sell units alone; `sellUnitFileOf` edits them.
 */
function fileOf(model: FileModel, edit: (lines: string[][]) => string[][]): Uint8Array {
  const [header, ...rows] = exportVariantFile(model)
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n')
    .map((line) => line.split(','));
  const legacy = rows.map((cells) => cells.filter((_, index) => index !== 5 && index !== 6));
  const widened = edit(legacy).map((cells) => [...cells.slice(0, 5), '', '', ...cells.slice(5)]);
  return bytes(`\uFEFF${[header!, ...widened].map((cells) => cells.join(',')).join('\r\n')}\r\n`);
}

/** The exported file with the cells of each row edited in the real layout (header kept). */
function sellUnitFileOf(model: FileModel, edit: (lines: string[][]) => string[][]): Uint8Array {
  const [header, ...rows] = exportVariantFile(model)
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\r\n')
    .map((line) => line.split(','));
  return bytes(
    `\uFEFF${[header!, ...edit(rows)].map((cells) => cells.join(',')).join('\r\n')}\r\n`,
  );
}

const read = (data: Uint8Array, model: FileModel): ImportPreview => {
  const result = readVariantFile(data, model);
  if (!result.ok) throw new Error(JSON.stringify(result.refusal));
  return result.preview;
};
const refusal = (data: Uint8Array, model: FileModel) => {
  const result = readVariantFile(data, model);
  if (result.ok) throw new Error('expected a refusal');
  return result.refusal;
};
const codes = (preview: ImportPreview) =>
  preview.errors.map((issue) => `${issue.rowNumber}:${issue.code}`);

describe.each(FIXTURES)('the variant file in the $name fixture', (fixture) => {
  /** A whole-amount price typed in a file, as the tab shows it in the fixture's currency. */
  const shown = (typed: string) => (fixture.currency === 'AUD' ? `${typed}.00` : typed);
  const model = modelOf(fixture);
  // Columns of the exported file: product, variant, colour, size, gtin, sku, selling, price,
  // stock x2, exported x2. `COL` is the layout `fileOf` edits (without sku and selling).
  const COL = {
    variant: 1,
    colour: 2,
    size: 3,
    gtin: 4,
    price: 5,
    stock1: 6,
    stock2: 7,
    exported1: 8,
  };

  describe('export', () => {
    it('writes the columns in order, the live variants only, with the exported levels', () => {
      const lines = exportVariantFile(model)
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');
      expect(lines[0]).toBe(
        'product_code,variant_code,option[colour],option[size],gtin,variant_sku,selling,price,stock[s1],stock[s2],stock_exported[s1],stock_exported[s2]',
      );
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain(`P-000001,P-000001-01`);
      expect(lines[1]!.endsWith(',10,4,10,4')).toBe(true);
      expect(lines.join('')).not.toContain('-03');
      // The sell-unit columns: the first variant has a SKU, both are on sale.
      expect(lines[1]).toContain(',00012345678905,RED-S,yes,');
      expect(lines[2]).toContain(',,yes,');
    });

    it('leaves out the price and stock columns the seller cannot see', () => {
      const header = exportVariantFile(modelOf(fixture, { showPrice: false, showStock: false }))
        .replace(/^\uFEFF/, '')
        .split('\r\n')[0];
      expect(header).toBe(
        'product_code,variant_code,option[colour],option[size],gtin,variant_sku,selling',
      );
    });

    it('re-imported unchanged gives an empty preview, with no row error or warning', () => {
      const preview = read(bytes(exportVariantFile(model)), model);
      expect(preview).toMatchObject({ changes: [], errors: [], warnings: [], ignoredColumns: [] });
      expect(preview.rowCount).toBe(2);
    });

    it('survives the formula guard: a label that starts with a minus comes back as it was', () => {
      const guarded = modelOf(fixture, {
        axes: [
          { code: 'colour', options: [{ code: 'red', label: '-5 off' }] },
          { code: 'size', options: [{ code: 'sm', label: '=Small' }] },
        ],
        variants: [modelOf(fixture).variants[0]!],
      });
      const text = exportVariantFile(guarded);
      expect(text).toContain("'-5 off");
      expect(text).toContain("'=Small");
      expect(read(bytes(text), guarded)).toMatchObject({ changes: [], errors: [], warnings: [] });
    });
  });

  describe('matching', () => {
    it('(a) refuses a row of another product and changes nothing from it', () => {
      const preview = read(
        fileOf(model, (rows) => {
          rows[0]![0] = 'P-000002';
          rows[0]![COL.price] = '99';
          return rows;
        }),
        model,
      );
      expect(codes(preview)).toEqual(['2:import.other-product']);
      expect(preview.changes).toEqual([]);
    });

    it('(b) uses the variant code alone: unknown, retired and conflicting keys are row errors', () => {
      const preview = read(
        fileOf(model, () => [
          ['P-000001', 'P-000001-09', '', '', '', '', '', '', '', ''],
          ['P-000001', 'P-000001-03', '', '', '', '', '', '', '', ''],
          // The code names variant 1, the labels name variant 2.
          ['P-000001', 'P-000001-01', fixture.colour[1], fixture.size[1], '', '', '', '', '', ''],
        ]),
        model,
      );
      expect(codes(preview)).toEqual([
        '2:import.variant-not-found',
        '3:import.variant-retired',
        '4:import.key-conflict',
      ]);
    });

    it('(b) a code that names a live variant wins over blank options', () => {
      const preview = read(
        fileOf(model, () => [['P-000001', 'P-000001-02', '', '', '', '3000', '', '', '', '']]),
        model,
      );
      expect(preview.errors).toEqual([]);
      expect(preview.changes).toHaveLength(1);
      expect(preview.changes[0]).toMatchObject({ variantId: 'v2', kind: 'price' });
    });

    it('(d) without a code, matches the option labels case- and space-insensitively, or the code', () => {
      const preview = read(
        fileOf(model, () => [
          [
            'P-000001',
            '',
            ` ${fixture.colour[0].toUpperCase()} `,
            fixture.size[0].replaceAll(' ', ''),
            '',
            '3000',
            '',
            '',
            '',
            '',
          ],
          ['P-000001', '', 'blue', 'lg', '', '3100', '', '', '', ''],
        ]),
        model,
      );
      expect(preview.errors).toEqual([]);
      expect(preview.changes.map((change) => [change.variantId, change.to])).toEqual([
        ['v1', shown('3000')],
        ['v2', shown('3100')],
      ]);
    });

    it('(d) every axis is required, an unknown label is never a new option, and no variant is not found', () => {
      const preview = read(
        fileOf(model, () => [
          ['P-000001', '', fixture.colour[0], '', '', '', '', '', '', ''],
          ['P-000001', '', 'Purple', fixture.size[0], '', '', '', '', '', ''],
          // A real combination that has no live variant (green is retired).
          ['P-000001', '', fixture.colour[2], fixture.size[0], '', '', '', '', '', ''],
          ['P-000001', '', fixture.colour[0], fixture.size[1], '', '', '', '', '', ''],
        ]),
        model,
      );
      expect(preview.errors).toEqual([
        { rowNumber: 2, code: 'import.option-missing', column: 'option[size]' },
        { rowNumber: 3, code: 'import.option-unknown', column: 'option[colour]' },
        { rowNumber: 4, code: 'import.variant-not-found' },
        { rowNumber: 5, code: 'import.variant-not-found' },
      ]);
    });

    it('(e) two rows for the same variant both fail, whichever key each used', () => {
      const preview = read(
        fileOf(model, () => [
          ['P-000001', 'P-000001-01', '', '', '', '3000', '', '', '', ''],
          ['P-000001', '', fixture.colour[0], fixture.size[0], '', '3100', '', '', '', ''],
          ['P-000001', 'P-000001-02', '', '', '', '3200', '', '', '', ''],
        ]),
        model,
      );
      expect(codes(preview)).toEqual(['2:import.duplicate-row', '3:import.duplicate-row']);
      // The third row is fine and the duplicates changed nothing.
      expect(preview.changes.map((change) => change.variantId)).toEqual(['v2']);
    });

    it('never creates, retires or renames: a variant left out of the file is untouched', () => {
      const preview = read(
        fileOf(model, (rows) => [rows[1]!.map((cell, i) => (i === COL.price ? '3000' : cell))]),
        model,
      );
      expect(preview.changes.map((change) => change.variantId)).toEqual(['v2']);
      expect(preview.errors).toEqual([]);
    });
  });

  describe('read-only columns', () => {
    it('a different gtin or option label is a warning and never a change', () => {
      const preview = read(
        fileOf(model, () => [
          [
            'P-000001',
            'P-000001-01',
            'Purple',
            fixture.size[1],
            '99999999999999',
            '',
            '',
            '',
            '',
            '',
          ],
        ]),
        model,
      );
      expect(preview.changes).toEqual([]);
      expect(preview.errors).toEqual([]);
      expect(preview.warnings).toEqual([
        { rowNumber: 2, code: 'import.read-only-column', column: 'gtin' },
        { rowNumber: 2, code: 'import.read-only-column', column: 'option[colour]' },
        { rowNumber: 2, code: 'import.read-only-column', column: 'option[size]' },
      ]);
    });
  });

  describe('columns', () => {
    it('lists unknown columns and ignores them', () => {
      const data = bytes(
        'product_code,variant_code,price,color,variant_sku,selling\r\nP-000001,P-000001-01,,x,RED-S,yes\r\n',
      );
      // variant_sku and selling are columns of the file (V5), so only `color` is ignored.
      expect(read(data, model).ignoredColumns).toEqual(['color']);
    });

    it('refuses the sell-unit columns without the edit key', () => {
      expect(
        refusal(bytes(exportVariantFile(model)), modelOf(fixture, { canEditSellUnits: false })),
      ).toEqual({ code: 'import.column-not-allowed', columns: ['variant_sku', 'selling'] });
    });
  });

  describe('sell units (variant_sku and selling)', () => {
    // Exported layout: product, variant, colour, size, gtin, sku, selling, price, ...
    const SKU = 5;
    const SELLING = 6;

    it('changes a SKU and the selling switch, shown as current value to file value', () => {
      const preview = read(
        sellUnitFileOf(model, (rows) => {
          rows[0]![SKU] = 'RED-SMALL';
          rows[1]![SKU] = 'BLUE-L';
          rows[1]![SELLING] = 'no';
          return rows;
        }),
        model,
      );
      expect(preview.errors).toEqual([]);
      expect(preview.changes.map((c) => [c.key, c.kind, c.from, c.to])).toEqual([
        ['sku:v1', 'sku', 'RED-S', 'RED-SMALL'],
        ['sku:v2', 'sku', '', 'BLUE-L'],
        ['selling:v2', 'selling', 'yes', 'no'],
      ]);
    });

    it('(c) uses a variant SKU as the key when the variant code is blank', () => {
      const preview = read(
        sellUnitFileOf(model, () => [
          ['P-000001', '', '', '', '', 'RED-S', 'no', '', '', '', '', ''],
        ]),
        model,
      );
      expect(preview.errors).toEqual([]);
      expect(preview.changes.map((c) => [c.variantId, c.kind, c.to])).toEqual([
        ['v1', 'selling', 'no'],
      ]);
    });

    it('(b) refuses a row whose SKU is another variant’s own as a key conflict', () => {
      const withSku = modelOf(fixture, {
        variants: modelOf(fixture).variants.map((v) =>
          v.variantId === 'v2' ? { ...v, variantSku: 'BLUE-L' } : v,
        ),
      });
      const preview = read(
        sellUnitFileOf(withSku, () => [
          ['P-000001', 'P-000001-01', '', '', '', 'BLUE-L', '', '', '', '', '', ''],
          [
            'P-000001',
            '',
            fixture.colour[0],
            fixture.size[0],
            '',
            'BLUE-L',
            '',
            '',
            '',
            '',
            '',
            '',
          ],
        ]),
        withSku,
      );
      expect(codes(preview)).toEqual(['2:import.key-conflict', '3:import.key-conflict']);
      expect(preview.changes).toEqual([]);
    });

    it('a SKU that is nobody’s is a new value for the variant the options name', () => {
      const preview = read(
        sellUnitFileOf(model, () => [
          ['P-000001', '', 'blue', 'lg', '', 'NEW-1', '', '', '', '', '', ''],
        ]),
        model,
      );
      expect(preview.changes.map((c) => [c.variantId, c.to])).toEqual([['v2', 'NEW-1']]);
    });

    it.each([['has space'], ['x'.repeat(65)], ['café']])(
      'refuses the SKU %j as an invalid value',
      (value) => {
        const preview = read(
          sellUnitFileOf(model, () => [
            ['P-000001', 'P-000001-02', '', '', '', value, '', '', '', '', '', ''],
          ]),
          model,
        );
        expect(preview.errors).toEqual([
          { rowNumber: 2, code: 'import.invalid-value', column: 'variant_sku' },
        ]);
        expect(preview.changes).toEqual([]);
      },
    );

    it('refuses a selling value that is not yes or no, and accepts yes in any case', () => {
      const preview = read(
        sellUnitFileOf(model, () => [
          ['P-000001', 'P-000001-01', '', '', '', '', 'maybe', '', '', '', '', ''],
          ['P-000001', 'P-000001-02', '', '', '', '', 'NO', '', '', '', '', ''],
        ]),
        model,
      );
      expect(preview.errors).toEqual([
        { rowNumber: 2, code: 'import.invalid-value', column: 'selling' },
      ]);
      expect(preview.changes.map((c) => [c.variantId, c.to])).toEqual([['v2', 'no']]);
    });

    it('fails both rows that ask for the same new SKU', () => {
      const preview = read(
        sellUnitFileOf(model, () => [
          ['P-000001', 'P-000001-01', '', '', '', 'SAME', '', '', '', '', '', ''],
          ['P-000001', 'P-000001-02', '', '', '', 'SAME', '', '', '', '', '', ''],
        ]),
        model,
      );
      expect(codes(preview)).toEqual(['2:import.duplicate-row', '3:import.duplicate-row']);
      expect(preview.changes).toEqual([]);
    });

    it('skips the on-sale changes that would leave no variant selling', () => {
      const preview = read(
        sellUnitFileOf(model, () => [
          ['P-000001', 'P-000001-01', '', '', '', '', 'no', '', '', '', '', ''],
          ['P-000001', 'P-000001-02', '', '', '', '', 'no', '', '', '', '', ''],
        ]),
        model,
      );
      expect(codes(preview)).toEqual(['2:import.none-selling', '3:import.none-selling']);
      expect(preview.changes).toEqual([]);
    });

    it('leaves a blank SKU or selling cell alone', () => {
      const preview = read(
        sellUnitFileOf(model, () => [
          ['P-000001', 'P-000001-01', '', '', '', '', '', '', '', '', '', ''],
        ]),
        model,
      );
      expect(preview).toMatchObject({ changes: [], errors: [] });
    });

    it.each([
      ['certification'],
      ['halal_certification'],
      ['handling'],
      ['status'],
      ['approval_status'],
    ])('refuses the %s column before any row is looked at', (column) => {
      const data = bytes(
        `product_code,variant_code,${column}\r\nP-000001,P-000001-01,approved\r\n`,
      );
      expect(refusal(data, model)).toEqual({
        code: 'import.column-refused',
        columns: [column],
      });
    });

    it('refuses the price column without the price key and the stock columns without the stock key', () => {
      const file = bytes(exportVariantFile(model));
      expect(refusal(file, modelOf(fixture, { canEditPrice: false }))).toEqual({
        code: 'import.column-not-allowed',
        columns: ['price'],
      });
      expect(refusal(file, modelOf(fixture, { canEditStock: false }))).toEqual({
        code: 'import.column-not-allowed',
        columns: ['stock[s1]', 'stock[s2]'],
      });
    });

    it('needs the product_code column', () => {
      expect(refusal(bytes('variant_code\r\nP-000001-01\r\n'), model)).toEqual({
        code: 'import.column-missing',
        columns: ['product_code'],
      });
    });
  });

  describe('changes and stale stock', () => {
    it('shows only changed cells, current value to file value', () => {
      const preview = read(
        fileOf(model, () => [
          ['P-000001', 'P-000001-01', '', '', '', fixture.priceText[1], '12', '4', '10', '4'],
        ]),
        model,
      );
      expect(preview.changes).toEqual([
        expect.objectContaining({
          kind: 'price',
          variantId: 'v1',
          from: fixture.priceText[0],
          to: fixture.priceText[1],
        }),
        expect.objectContaining({
          kind: 'stock',
          sourceId: 's1',
          from: '10',
          to: '12',
        }),
      ]);
      expect(preview.changes.every((change) => change.code === undefined)).toBe(true);
    });

    it('marks a stock cell whose level moved since the export as import.stock-changed', () => {
      const exportedAtTen = fileOf(model, (rows) =>
        rows.map((row) => row.map((cell, i) => (i === COL.stock1 ? '12' : cell))),
      );
      // The level is 7 now (a sale), the file was written at 10 and asks for 12.
      const moved = modelOf(fixture, {
        variants: model.variants.map((variant) => ({
          ...variant,
          stock: { ...variant.stock, s1: { onHand: 7 } },
        })),
      });
      const preview = read(exportedAtTen, moved);
      const stale = preview.changes.filter((change) => change.kind === 'stock');
      expect(stale).toHaveLength(2);
      expect(stale.every((change) => change.code === 'import.stock-changed')).toBe(true);
    });

    it('treats a missing or empty stock_exported value the same way', () => {
      const noExported = bytes(
        'product_code,variant_code,stock[s1]\r\nP-000001,P-000001-01,12\r\n',
      );
      expect(read(noExported, model).changes).toEqual([
        expect.objectContaining({ kind: 'stock', code: 'import.stock-changed' }),
      ]);
      const emptyExported = fileOf(model, () => [
        ['P-000001', 'P-000001-01', '', '', '', '', '12', '', '', ''],
      ]);
      expect(read(emptyExported, model).changes).toEqual([
        expect.objectContaining({ kind: 'stock', code: 'import.stock-changed' }),
      ]);
    });

    it('does not flag a cell that equals the current level, whatever was exported', () => {
      const data = bytes(
        'product_code,variant_code,stock[s1],stock_exported[s1]\r\nP-000001,P-000001-01,10,3\r\n',
      );
      expect(read(data, model).changes).toEqual([]);
    });

    it('reports a price or stock value that is not valid as a row error, with its column', () => {
      const preview = read(
        fileOf(model, () => [
          ['P-000001', 'P-000001-01', '', '', '', 'abc', '', '', '', ''],
          ['P-000001', 'P-000001-02', '', '', '', '', '-3', '1.5', '', ''],
        ]),
        model,
      );
      expect(preview.errors).toContainEqual({
        rowNumber: 2,
        code: 'import.invalid-value',
        column: 'price',
      });
      expect(preview.errors).toContainEqual({
        rowNumber: 3,
        code: 'import.invalid-value',
        column: 'stock[s1]',
      });
      expect(preview.errors).toContainEqual({
        rowNumber: 3,
        code: 'import.invalid-value',
        column: 'stock[s2]',
      });
      expect(preview.changes).toEqual([]);
    });
  });

  describe('file limits', () => {
    it('refuses row max + 1 with the cap, and accepts row max', () => {
      const small = modelOf(fixture, { maxRows: 2 });
      const row = (n: number) => `P-000001,P-000001-0${n}`;
      const header = 'product_code,variant_code';
      expect(read(bytes(`${header}\r\n${row(1)}\r\n${row(2)}\r\n`), small).rowCount).toBe(2);
      expect(refusal(bytes(`${header}\r\n${row(1)}\r\n${row(2)}\r\n${row(1)}\r\n`), small)).toEqual(
        {
          code: 'import.too-many-rows',
          max: 2,
        },
      );
    });

    it('refuses more than 64 columns, a cell over 10,000 characters and a file over 1 MiB', () => {
      const wide = Array.from({ length: 65 }, (_, i) => `c${i}`).join(',');
      expect(refusal(bytes(`${wide}\r\n1\r\n`), model)).toEqual({
        code: 'file.too-many-columns',
        max: 64,
      });
      expect(
        refusal(bytes(`product_code\r\n${'x'.repeat(FILE_LIMITS.cellChars + 1)}\r\n`), model),
      ).toMatchObject({ code: 'file.cell-too-long' });
      expect(refusal(new Uint8Array(FILE_LIMITS.bytes + 1), model)).toEqual({
        code: 'file.too-large',
        maxBytes: FILE_LIMITS.bytes,
      });
    });

    it('refuses an empty file, a binary file, bytes that are not UTF-8 and a header-only file', () => {
      expect(refusal(new Uint8Array(0), model)).toEqual({ code: 'file.unsupported-type' });
      expect(refusal(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), model)).toEqual({
        code: 'file.unsupported-type',
      });
      expect(refusal(new Uint8Array([0x61, 0xff, 0xfe, 0x0a]), model)).toMatchObject({
        code: expect.stringMatching(/^file\./) as string,
      });
      expect(refusal(bytes('product_code,variant_code\r\n'), model)).toEqual({
        code: 'file.no-rows',
      });
    });

    it('never evaluates a formula: a formula in a cell is only text and never matches', () => {
      const preview = read(bytes(`product_code,variant_code\r\nP-000001,"=1+1"\r\n`), model);
      expect(codes(preview)).toEqual(['2:import.variant-not-found']);
    });
  });
});

describe('labelKey', () => {
  it('ignores case, any space and width variants', () => {
    expect(labelKey(' Extra  Large ')).toBe(labelKey('extralarge'));
    expect(labelKey('ＡＢＣ')).toBe('abc');
  });
});
