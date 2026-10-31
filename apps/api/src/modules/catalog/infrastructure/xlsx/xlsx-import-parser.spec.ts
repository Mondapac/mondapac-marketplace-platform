import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import {
  contentTypesXml,
  MAIN_TYPE,
  workbookBytes,
  workbookSkeleton,
  zipOf,
  type Cells,
} from '../../../../../test/support/zip-fixtures';
import {
  csvParser,
  readImportFile,
  type FileRefusal,
  type ParsedTable,
} from '../../domain/platform-import/import-file';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import { ExceljsSheetWriter } from './exceljs-sheet-writer';
import { createXlsxParser, dateText, numberText, xlsxParser } from './xlsx-import-parser';
import { inspectXlsxContainer } from './zip-inspection';

const PARSERS = [csvParser, xlsxParser];

async function read(bytes: Uint8Array): Promise<ParsedTable> {
  const result = await readImportFile(bytes, IMPORT_LIMITS, PARSERS);
  if (!result.ok) throw new Error(`refused: ${result.error.code}`);
  return result.value;
}

async function refusal(bytes: Uint8Array): Promise<FileRefusal> {
  const result = await readImportFile(bytes, IMPORT_LIMITS, PARSERS);
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
}

const HEADER = ['Title', 'Main category', 'Product type', 'Brand'];

describe('xlsxParser: a good file', () => {
  it('reads the first worksheet into a table, row numbers as the spreadsheet shows them', async () => {
    const bytes = await workbookBytes([
      HEADER,
      ['Lamb shoulder', 'Meat', 'simple', 'Example Farms'],
      [],
      ['Chicken', 'Meat', 'simple', 'Other'],
    ]);
    const table = await read(bytes);
    expect(table.format).toBe('xlsx');
    expect(table.header).toEqual(HEADER);
    expect(table.rows).toEqual([
      { rowNumber: 2, cells: ['Lamb shoulder', 'Meat', 'simple', 'Example Farms'] },
      { rowNumber: 4, cells: ['Chicken', 'Meat', 'simple', 'Other'] },
    ]);
    expect(table.rowCount).toBe(2);
  });

  it('pads short rows to the header and ignores cells past it', async () => {
    const table = await read(await workbookBytes([HEADER, ['A'], ['B', 'C', 'D', 'E', 'extra']]));
    expect(table.rows.map((row) => row.cells)).toEqual([
      ['A', '', '', ''],
      ['B', 'C', 'D', 'E'],
    ]);
  });

  it('reads only the first worksheet', async () => {
    const bytes = await workbookBytes([HEADER, ['First', 'Meat', 'simple', 'B']], {
      Second: [HEADER, ['Second', 'Meat', 'simple', 'B']],
    });
    const table = await read(bytes);
    expect(table.rows.map((row) => row.cells[0])).toEqual(['First']);
  });

  it('never trims a cell and keeps a text that starts with = as text', async () => {
    const bytes = await workbookBytes([['Title'], ['  padded  '], ['=1+1'], ['@SUM(A1)']]);
    const table = await read(bytes);
    expect(table.rows.map((row) => row.cells[0])).toEqual(['  padded  ', '=1+1', '@SUM(A1)']);
  });

  it('reads rich text and a link as their visible text only', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Products');
    sheet.addRow(['Title', 'Description']);
    sheet.addRow([
      'Linked',
      { richText: [{ text: 'Bone-in ' }, { text: 'shoulder', font: { bold: true } }] },
    ]);
    sheet.getCell('A2').value = { text: 'Shown text', hyperlink: 'https://example.invalid/x' };
    const table = await read(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(table.rows[0]!.cells).toEqual(['Shown text', 'Bone-in shoulder']);
  });
});

describe('xlsxParser: values become text deterministically', () => {
  it('formats dates as UTC ISO text whatever the time zone of the server', async () => {
    const bytes = await workbookBytes([
      ['When'],
      [new Date(Date.UTC(2026, 9, 31))],
      [new Date(Date.UTC(2026, 9, 31, 23, 30, 5))],
    ]);
    const original = process.env['TZ'];
    try {
      for (const zone of ['UTC', 'Australia/Brisbane', 'America/Los_Angeles']) {
        process.env['TZ'] = zone;
        const table = await read(bytes);
        expect(table.rows.map((row) => row.cells[0])).toEqual([
          '2026-10-31',
          '2026-10-31T23:30:05Z',
        ]);
      }
    } finally {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    }
  });

  it('formats numbers and booleans', async () => {
    const bytes = await workbookBytes([['V'], [5901234123457], [0.5], [-0], [12], [true], [false]]);
    const table = await read(bytes);
    expect(table.rows.map((row) => row.cells[0])).toEqual([
      '5901234123457',
      '0.5',
      '0',
      '12',
      'TRUE',
      'FALSE',
    ]);
  });

  it('has pure helpers for dates and numbers', () => {
    expect(dateText(new Date(Date.UTC(2026, 0, 2)))).toBe('2026-01-02');
    expect(dateText(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('2026-01-02T03:04:05Z');
    expect(dateText(new Date('nope'))).toBe('');
    expect(numberText(-0)).toBe('0');
    expect(numberText(1e21)).toBe('1e+21');
  });
});

describe('xlsxParser: refusals', () => {
  it('refuses a formula cell, naming the row, and never reads its cached result', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Products');
    sheet.addRow(['Title', 'Brand']);
    sheet.addRow(['A', 'B']);
    sheet.addRow(['C', 'D']);
    sheet.getCell('B3').value = { formula: 'UPPER("x")', result: 'X' };
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await refusal(bytes)).toEqual({ code: 'file.formula-cell', rowNumber: 3 });
  });

  it('refuses a formula cell outside the columns of the header too', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Products');
    sheet.addRow(['Title']);
    sheet.addRow(['A']);
    sheet.getCell('F2').value = { formula: '1+1', result: 2 };
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    expect(await refusal(bytes)).toEqual({ code: 'file.formula-cell', rowNumber: 2 });
  });

  it('refuses a cell over the character limit, naming the row', async () => {
    const bytes = await workbookBytes([
      ['Title'],
      ['ok'],
      ['x'.repeat(IMPORT_LIMITS.cellChars + 1)],
    ]);
    expect(await refusal(bytes)).toEqual({
      code: 'file.cell-too-long',
      rowNumber: 3,
      max: IMPORT_LIMITS.cellChars,
    });
  });

  it('accepts a cell of exactly the character limit', async () => {
    const table = await read(
      await workbookBytes([['Title'], ['x'.repeat(IMPORT_LIMITS.cellChars)]]),
    );
    expect(table.rows[0]!.cells[0]).toHaveLength(IMPORT_LIMITS.cellChars);
  });

  it('refuses more rows than the limit, saying how many, and accepts exactly the limit', async () => {
    const make = (count: number): Cells => [
      ['Title'],
      ...Array.from({ length: count }, (_, i) => [`P${i}`]),
    ];
    expect(await refusal(await workbookBytes(make(IMPORT_LIMITS.rows + 1)))).toEqual({
      code: 'file.too-many-rows',
      rows: IMPORT_LIMITS.rows + 1,
      max: IMPORT_LIMITS.rows,
    });
    expect((await read(await workbookBytes(make(IMPORT_LIMITS.rows)))).rowCount).toBe(
      IMPORT_LIMITS.rows,
    );
  });

  it('refuses a header with too many columns', async () => {
    const header = Array.from({ length: IMPORT_LIMITS.columns + 1 }, (_, i) => `c${i}`);
    expect(await refusal(await workbookBytes([header, ['1']]))).toEqual({
      code: 'file.too-many-columns',
      max: IMPORT_LIMITS.columns,
    });
  });

  it('refuses an empty sheet and a header without rows as no rows', async () => {
    expect(await refusal(await workbookBytes([]))).toEqual({ code: 'file.no-rows' });
    expect(await refusal(await workbookBytes([HEADER]))).toEqual({ code: 'file.no-rows' });
    expect(await refusal(await workbookBytes([[], []]))).toEqual({ code: 'file.no-rows' });
  });

  it('refuses a file over the byte limit before reading it', async () => {
    const big = new Uint8Array(IMPORT_LIMITS.fileBytes + 1);
    big.set([0x50, 0x4b, 0x03, 0x04]);
    expect(await refusal(big)).toEqual({
      code: 'file.too-large',
      maxBytes: IMPORT_LIMITS.fileBytes,
    });
  });
});

describe('xlsxParser: the container is looked at before exceljs sees it', () => {
  it('refuses a zip that is not a workbook (no [Content_Types].xml or no workbook part)', async () => {
    const docx = zipOf([
      { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
      { name: 'word/document.xml', data: Buffer.from('<d/>') },
    ]);
    expect(await refusal(docx)).toEqual({ code: 'file.unsupported-type', detected: 'other' });
    expect(await refusal(zipOf([{ name: 'a.txt', data: Buffer.from('hi') }]))).toEqual({
      code: 'file.unsupported-type',
      detected: 'other',
    });
    // The first bytes of a zip and nothing else.
    expect(await refusal(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toEqual({
      code: 'file.unsupported-type',
      detected: 'other',
    });
  });

  it('refuses the wrong content type: macro-enabled, template and binary workbooks', async () => {
    for (const type of [
      'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml',
      'application/vnd.ms-excel.sheet.binary.macroEnabled.main',
    ]) {
      expect(await refusal(zipOf(workbookSkeleton(type)))).toEqual({
        code: 'file.unsupported-type',
        detected: 'other',
      });
    }
    // The plain type passes the container checks.
    const inspected = await inspectXlsxContainer(zipOf(workbookSkeleton()), IMPORT_LIMITS);
    expect(inspected.ok).toBe(true);
  });

  it('refuses a macro project, an external link, an embedded object and a DTD', async () => {
    const extras: { name: string; data: string }[] = [
      { name: 'xl/vbaProject.bin', data: 'MZ' },
      { name: 'xl/externalLinks/externalLink1.xml', data: '<externalLink/>' },
      { name: 'xl/embeddings/oleObject1.bin', data: 'x' },
      { name: 'xl/activeX/activeX1.xml', data: '<a/>' },
    ];
    for (const extra of extras) {
      const zip = zipOf([
        ...workbookSkeleton(),
        { name: extra.name, data: Buffer.from(extra.data) },
      ]);
      expect(await refusal(zip)).toEqual({ code: 'file.unsupported-type', detected: 'other' });
    }
    const dtd = zipOf([
      { name: '[Content_Types].xml', data: contentTypesXml(MAIN_TYPE) },
      {
        name: 'xl/workbook.xml',
        data: Buffer.from('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><workbook/>'),
      },
    ]);
    expect((await refusal(dtd)).code).toBe('file.unsupported-type');
  });

  it('refuses a zip bomb by the declared sizes without unpacking it', async () => {
    const zeros = Buffer.alloc(IMPORT_LIMITS.decompressedBytes + 1024 * 1024);
    const bomb = zipOf([...workbookSkeleton(), { name: 'xl/worksheets/sheet1.xml', data: zeros }]);
    expect(bomb.length).toBeLessThan(IMPORT_LIMITS.fileBytes);
    expect(await refusal(bomb)).toEqual({
      code: 'file.unpacked-too-large',
      maxBytes: IMPORT_LIMITS.decompressedBytes,
    });
  });

  it('refuses a suspicious compression ratio even when the total is under the limit', async () => {
    const zeros = Buffer.alloc(8 * 1024 * 1024);
    const dense = zipOf([...workbookSkeleton(), { name: 'xl/worksheets/sheet1.xml', data: zeros }]);
    expect(dense.length).toBeLessThan(zeros.length / IMPORT_LIMITS.compressionRatio);
    expect(await refusal(dense)).toEqual({
      code: 'file.unpacked-too-large',
      maxBytes: IMPORT_LIMITS.decompressedBytes,
    });
  });

  it('refuses a header that lies about its size: the inflate is bounded by the declared size', async () => {
    const real = Buffer.alloc(4 * 1024 * 1024, 'a');
    const liar = zipOf([
      ...workbookSkeleton(),
      { name: 'xl/worksheets/sheet1.xml', data: real, declaredUncompressed: 1024 },
    ]);
    expect(await refusal(liar)).toEqual({
      code: 'file.unpacked-too-large',
      maxBytes: IMPORT_LIMITS.decompressedBytes,
    });
    const short = zipOf([
      ...workbookSkeleton(),
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<s/>'), declaredUncompressed: 99 },
    ]);
    expect(await refusal(short)).toEqual({ code: 'file.unreadable' });
  });

  it('refuses trailing bytes, encryption, odd methods, bad names, duplicates and too many entries', async () => {
    const plain = workbookSkeleton();
    expect((await refusal(zipOf(plain, Buffer.from('tail')))).code).toBe('file.unsupported-type');
    expect(await refusal(zipOf([{ ...plain[0]!, flags: 1 }, plain[1]!]))).toEqual({
      code: 'file.unsupported-type',
      detected: 'other',
    });
    for (const name of ['../evil.xml', '/abs.xml', 'a\\b.xml']) {
      expect(await refusal(zipOf([...plain, { name, data: Buffer.from('x') }]))).toEqual({
        code: 'file.unreadable',
      });
    }
    expect(await refusal(zipOf([...plain, { ...plain[1]! }]))).toEqual({ code: 'file.unreadable' });
    const many = Array.from({ length: IMPORT_LIMITS.containerEntries + 1 }, (_, i) => ({
      name: `p${i}.xml`,
      data: Buffer.from('x'),
      method: 0 as const,
    }));
    expect((await refusal(zipOf([...plain, ...many]))).code).toBe('file.unpacked-too-large');
  });

  it('refuses a stored entry whose bytes do not match its checksum', async () => {
    const plain = zipOf([
      ...workbookSkeleton(),
      { name: 'x.xml', data: Buffer.from('abcd'), method: 0 },
    ]);
    const at = plain.indexOf(Buffer.from('abcd'));
    plain[at] = 0x7a;
    expect(await refusal(plain)).toEqual({ code: 'file.unreadable' });
  });

  it('refuses a damaged workbook that passes the container checks', async () => {
    const parts = [
      ...workbookSkeleton(),
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<x') },
    ];
    expect((await refusal(zipOf(parts))).code).toBe('file.unreadable');
  });
});

describe('ExceljsSheetWriter', () => {
  async function collect(rows: string[][]): Promise<Buffer> {
    async function* source(): AsyncGenerator<readonly string[]> {
      await Promise.resolve();
      for (const row of rows) yield row;
    }
    const parts: Uint8Array[] = [];
    for await (const chunk of new ExceljsSheetWriter().xlsx('Products', source()))
      parts.push(chunk);
    return Buffer.concat(parts);
  }

  it('stops reading its rows when the reader leaves, instead of writing a whole sheet nobody reads (Hassan L-583-2)', async () => {
    let pulled = 0;
    let closed = false;
    async function* source(): AsyncGenerator<readonly string[]> {
      try {
        for (let n = 0; n < 200_000; n += 1) {
          // Rows that do not compress away: the buffer fills and the writer must wait.
          await Promise.resolve();
          pulled += 1;
          yield [`${n}-${randomBytes(48).toString('hex')}`, randomBytes(48).toString('hex')];
        }
      } finally {
        closed = true;
      }
    }
    const out = new ExceljsSheetWriter().xlsx('Products', source());
    let chunks = 0;
    for await (const chunk of out) {
      if (chunk.length > 0) chunks += 1;
      if (chunks === 2) break; // the client closed the tab
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(closed).toBe(true);
    expect(pulled).toBeLessThan(20_000);
  }, 30_000);

  it('writes every cell as a string, never a formula, and reads back with the importer', async () => {
    const rows = [
      ['Product', 'Offers'],
      ['=HYPERLINK("http://x.invalid","click")', '3'],
      ['+1', '-2'],
      ['@SUM(A1)', '\tTab'],
      ['plain', ''],
    ];
    const file = await collect(rows);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file as never);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.name).toBe('Products');
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        expect(typeof cell.value).toBe('string');
        expect(cell.type).toBe(ExcelJS.ValueType.String);
      });
    });
    expect(sheet.getCell('A2').value).toBe('=HYPERLINK("http://x.invalid","click")');
    expect(sheet.getCell('B2').value).toBe('3');
    // The importer reads the same text back, with no formula cell.
    const table = await read(file);
    expect(table.rows[0]!.cells).toEqual(['=HYPERLINK("http://x.invalid","click")', '3']);
  });
});

// A workbook made by hand around one sheet's XML, so a test controls the size and the order of
// its parts (the parts exceljs writes are in a fixed order and small).
const WORKBOOK_XML =
  '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELS_XML =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '</Relationships>';

function sheetXml(rows: readonly (readonly [number, readonly string[]])[]): string {
  const body = rows
    .map(
      ([number, cells]) =>
        `<row r="${number}">` +
        cells
          .map(
            (text, index) =>
              `<c r="${String.fromCharCode(65 + index)}${number}" t="inlineStr"><is><t>${text}</t></is></c>`,
          )
          .join('') +
        '</row>',
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function handMade(sheet: string, extra: { name: string; data: Buffer }[] = []): Buffer {
  return zipOf([
    // The sheet before the workbook parts: the streaming read must not depend on the order.
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) },
    { name: '[Content_Types].xml', data: contentTypesXml(MAIN_TYPE) },
    { name: 'xl/workbook.xml', data: Buffer.from(WORKBOOK_XML) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(RELS_XML) },
    ...extra,
  ]);
}

describe('xlsxParser: the read is streaming and bounded (Hassan M-586-1)', () => {
  it('stops at the first row past the limit of a very large sheet, and refuses it', async () => {
    // 60,000 rows of 3 cells (about 10 MB of XML, under every size limit).
    const rows: [number, string[]][] = [[1, ['Title', 'Brand', 'Code']]];
    for (let n = 2; n <= 60_000; n += 1) rows.push([n, [`P${n}`, 'Farms', `C${n}`]]);
    const file = handMade(sheetXml(rows));
    expect(file.length).toBeLessThan(IMPORT_LIMITS.fileBytes);

    const seen: number[] = [];
    const parser = createXlsxParser((rowNumber) => seen.push(rowNumber));
    const result = await readImportFile(file, IMPORT_LIMITS, [csvParser, parser]);
    expect(result).toEqual({
      ok: false,
      error: { code: 'file.too-many-rows', rows: IMPORT_LIMITS.rows + 1, max: IMPORT_LIMITS.rows },
    });
    // Parsing stopped a chunk after row 5,001: nowhere near the 60,000 rows of the sheet.
    expect(Math.max(...seen)).toBeGreaterThan(IMPORT_LIMITS.rows);
    expect(seen.length).toBeLessThan(IMPORT_LIMITS.rows + 2500);
  });

  it('reads a good sheet that has no shared strings and no styles part', async () => {
    const table = await read(
      handMade(
        sheetXml([
          [1, ['Title', 'Brand']],
          [2, ['Dates', 'Farms']],
        ]),
      ),
    );
    expect(table.header).toEqual(['Title', 'Brand']);
    expect(table.rows).toEqual([{ rowNumber: 2, cells: ['Dates', 'Farms'] }]);
  });

  it('refuses a sheet part over its size limit, whatever the total and the ratio', async () => {
    // About 16 MiB of XML that packs only 3 to 4 times: under the 50 MiB total, over the 15 MiB part.
    const filler = randomBytes(24).toString('hex');
    const rows: [number, string[]][] = [[1, ['Title']]];
    let size = 0;
    for (let n = 2; size < IMPORT_LIMITS.worksheetPartBytes * 1.1; n += 1) {
      const text = `${randomBytes(20).toString('hex')}${filler}`;
      rows.push([n, [text]]);
      size += text.length + 60;
    }
    const file = handMade(sheetXml(rows));
    expect(file.length).toBeLessThan(IMPORT_LIMITS.fileBytes);
    expect(await refusal(file)).toEqual({
      code: 'file.unpacked-too-large',
      maxBytes: IMPORT_LIMITS.worksheetPartBytes,
    });
  }, 60_000);

  it('refuses a shared-strings part and another XML part over their limits', async () => {
    const big = (bytes: number): Buffer => Buffer.from(randomBytes(bytes / 2).toString('hex'));
    const sheet = sheetXml([
      [1, ['Title']],
      [2, ['A']],
    ]);
    const strings = handMade(sheet, [
      { name: 'xl/sharedStrings.xml', data: big(IMPORT_LIMITS.sharedStringsPartBytes + 2048) },
    ]);
    expect(await refusal(strings)).toEqual({
      code: 'file.unpacked-too-large',
      maxBytes: IMPORT_LIMITS.sharedStringsPartBytes,
    });
    const styles = handMade(sheet, [
      { name: 'xl/styles.xml', data: big(IMPORT_LIMITS.xmlPartBytes + 2048) },
    ]);
    expect(await refusal(styles)).toEqual({
      code: 'file.unpacked-too-large',
      maxBytes: IMPORT_LIMITS.xmlPartBytes,
    });
  }, 60_000);

  it('refuses a data row past the last row number the job table can hold', async () => {
    const file = handMade(
      sheetXml([
        [1, ['Title']],
        [2, ['A']],
        [IMPORT_LIMITS.rows + 3, ['Z']],
      ]),
    );
    expect(await refusal(file)).toEqual({
      code: 'file.too-many-rows',
      rows: IMPORT_LIMITS.rows + 1,
      max: IMPORT_LIMITS.rows,
    });
    const atLimit = handMade(
      sheetXml([
        [1, ['Title']],
        [2, ['A']],
        [IMPORT_LIMITS.rows + 2, ['Z']],
      ]),
    );
    expect((await read(atLimit)).rows.map((row) => row.rowNumber)).toEqual([2, 5002]);
  });
});

describe('xlsxParser: no entity or document type hides in an XML part (Hassan L-586-2)', () => {
  const doctype = '<!DOCTYPE x [<!ENTITY a "b">]>';

  it('finds a DOCTYPE after a long comment, in any XML part', async () => {
    const comment = `<!--${'x'.repeat(8192)}-->`;
    const sheet = sheetXml([
      [1, ['Title']],
      [2, ['A']],
    ]);
    const hidden = `<?xml version="1.0"?>${comment}${doctype}<root/>`;
    for (const name of ['xl/styles.xml', 'xl/theme/theme1.xml', 'xl/_rels/other.rels', 'x/y.xml']) {
      const file = handMade(sheet, [{ name, data: Buffer.from(hidden) }]);
      expect(await refusal(file)).toEqual({ code: 'file.unsupported-type', detected: 'other' });
    }
    // The same text inside the sheet itself.
    const inSheet = handMade(sheet.replace('<sheetData>', `${comment}${doctype}<sheetData>`));
    expect(await refusal(inSheet)).toEqual({ code: 'file.unsupported-type', detected: 'other' });
  });

  it('refuses an XML part in UTF-16, which a Latin-1 scan cannot see into', async () => {
    const utf16 = Buffer.from(`\uFEFF<?xml version="1.0"?>${doctype}<root/>`, 'utf16le');
    const noBom = Buffer.from(`<?xml version="1.0"?>${doctype}<root/>`, 'utf16le');
    const sheet = sheetXml([
      [1, ['Title']],
      [2, ['A']],
    ]);
    for (const data of [utf16, noBom]) {
      const file = handMade(sheet, [{ name: 'xl/styles.xml', data }]);
      expect(await refusal(file)).toEqual({ code: 'file.unsupported-type', detected: 'other' });
    }
  });
});

describe('xlsxParser: the table is also given as plain CSV (parsed once)', () => {
  it('reads back to the same header, rows, row numbers and cells', async () => {
    const bytes = await workbookBytes([
      [],
      ['Title', 'Description', 'Brand'],
      ['Plain', 'a, b', 'Farms'],
      [],
      ['Quote "x"', 'line one\nline two', ''],
      ['\uFEFFBom first', '  padded  ', '=1+1'],
      ['only title'],
    ]);
    const parsed = await readImportFile(bytes, IMPORT_LIMITS, PARSERS);
    if (!parsed.ok) throw new Error(parsed.error.code);
    const canonical = parsed.value.canonical;
    expect(canonical).toBeDefined();
    const again = await readImportFile(canonical!, IMPORT_LIMITS, PARSERS);
    if (!again.ok) throw new Error(again.error.code);
    expect(again.value.format).toBe('csv');
    expect(again.value.header).toEqual(parsed.value.header);
    expect(again.value.rows).toEqual(parsed.value.rows);
    expect(again.value.rowCount).toBe(parsed.value.rowCount);
    expect(again.value.rows.map((row) => row.rowNumber)).toEqual([3, 5, 6, 7]);
  });

  it('keeps a row whose own cells are all empty (cells only past the header) as a row', async () => {
    const parsed = await readImportFile(
      await workbookBytes([['Title'], ['A'], ['', 'beyond the header'], ['B']]),
      IMPORT_LIMITS,
      PARSERS,
    );
    if (!parsed.ok) throw new Error(parsed.error.code);
    const again = await readImportFile(parsed.value.canonical!, IMPORT_LIMITS, PARSERS);
    if (!again.ok) throw new Error(again.error.code);
    expect(again.value.rows).toEqual(parsed.value.rows);
    expect(again.value.rows.map((row) => row.rowNumber)).toEqual([2, 3, 4]);
  });

  it('is not given for a CSV, which is stored as it came', async () => {
    const parsed = await readImportFile(Buffer.from('Title\nA\n'), IMPORT_LIMITS, PARSERS);
    expect(parsed.ok && parsed.value.canonical).toBeFalsy();
  });
});
