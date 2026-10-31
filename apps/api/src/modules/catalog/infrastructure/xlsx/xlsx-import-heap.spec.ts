import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { contentTypesXml, MAIN_TYPE, zipOf } from '../../../../../test/support/zip-fixtures';
import type { FileRefusal } from '../../domain/platform-import/import-file';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import { xlsxParser } from './xlsx-import-parser';

// Hassan M-586-1: an XLSX within the size limits must not cost memory out of proportion to its
// bytes. Each case runs the parse in a child process (a Jest run of this same file) whose V8
// old space is capped at 256 MiB, with the whole parse including the Jest runtime inside it. The
// files that used to reach 0.9 GB of RSS (15 MiB of rows, 700,000 cells in one row) must be
// refused cleanly, and a big sheet that is within every limit must still be read.
//
// Hassan M-586-5: one long shared string that many cells point at must not grow the canonical CSV
// past the file limit in memory. The file is within every limit; the text it stands for is not,
// and the parse refuses it as `file.too-large` the moment the running byte count passes the cap.

const HEAP_MIB = 256;
const CASE = process.env['XLSX_HEAP_CASE'];

const WORKBOOK_XML =
  '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>';
const SHEET_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
const SHEET_TAIL = '</sheetData></worksheet>';
const HEADER_ROW =
  '<row r="1">' +
  ['Title', 'Main category', 'Product type', 'Brand']
    .map(
      (text, i) =>
        `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>${text}</t></is></c>`,
    )
    .join('') +
  '</row>';

/** The column name of a zero-based index: A to Z, then AA, AB, ... */
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/** A header of IMPORT_LIMITS.columns inline-string cells, so a data row can be that wide. */
const WIDE_HEADER_ROW =
  '<row r="1">' +
  Array.from(
    { length: IMPORT_LIMITS.columns },
    (_, i) => `<c r="${columnName(i)}1" t="inlineStr"><is><t>Column ${i + 1}</t></is></c>`,
  ).join('') +
  '</row>';

/** One shared string of the cell limit's length (10,000 characters). */
const LONG_STRING = 'x'.repeat(IMPORT_LIMITS.cellChars);
const SHARED_STRINGS_XML = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">' +
    `<si><t>${LONG_STRING}</t></si></sst>`,
);

/** A workbook whose sheet is STORED (ratio 1), so that size, not compression, is what is tested. */
function workbook(sheet: Buffer, sharedStrings: Buffer | null = null): Buffer {
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';
  return zipOf([
    { name: '[Content_Types].xml', data: contentTypesXml(MAIN_TYPE) },
    { name: 'xl/workbook.xml', data: Buffer.from(WORKBOOK_XML) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels) },
    ...(sharedStrings === null
      ? []
      : [{ name: 'xl/sharedStrings.xml', data: sharedStrings, method: 0 }]),
    { name: 'xl/worksheets/sheet1.xml', data: sheet, method: 0 },
  ]);
}

/** Rows built piece by piece into Buffers, so the test itself holds almost nothing on the heap. */
function sheetOf(pieces: Iterable<string>, headerRow: string = HEADER_ROW): Buffer {
  const parts: Buffer[] = [Buffer.from(SHEET_HEAD + headerRow)];
  let batch = '';
  for (const piece of pieces) {
    batch += piece;
    if (batch.length > 1 << 20) {
      parts.push(Buffer.from(batch));
      batch = '';
    }
  }
  parts.push(Buffer.from(batch + SHEET_TAIL));
  return Buffer.concat(parts);
}

const numberCell = (ref: string): string =>
  `<c r="${ref}"><v>${randomInt(100_000, 999_999)}</v></c>`;

const SHEET_LIMIT = IMPORT_LIMITS.worksheetPartBytes - 4096;

/** About 15 MiB of rows with 26 numeric cells each (Hassan's file B): some 70,000 rows. */
function* manyRows(): Generator<string> {
  let bytes = 0;
  for (let row = 2; bytes < SHEET_LIMIT; row += 1) {
    let text = `<row r="${row}">`;
    for (let col = 0; col < 26; col += 1)
      text += numberCell(`${String.fromCharCode(65 + col)}${row}`);
    text += '</row>';
    bytes += text.length;
    yield text;
  }
}

/** A header and one data row of about 450,000 `<c>` elements (Hassan's file D). */
function* oneWideRow(): Generator<string> {
  yield '<row r="2">';
  for (let i = 0; i < 450_000; i += 1) yield numberCell(`A2`);
  yield '</row>';
}

/** The biggest sheet that is within every limit: 5,001 data rows of 64 cells. */
function* withinLimits(): Generator<string> {
  for (let row = 2; row <= IMPORT_LIMITS.rows + 1; row += 1) {
    let text = `<row r="${row}">`;
    for (let col = 0; col < 64; col += 1) {
      text += numberCell(`${String.fromCharCode(65 + (col % 26))}${row}`);
    }
    yield text + '</row>';
  }
}

/** `rows` data rows of 64 cells, every one pointing at the shared string (Hassan's file E). */
function reusedStringRows(rows: number): () => Generator<string> {
  return function* () {
    for (let row = 2; row <= rows + 1; row += 1) {
      let text = `<row r="${row}">`;
      for (let col = 0; col < IMPORT_LIMITS.columns; col += 1) {
        text += `<c r="${columnName(col)}${row}" t="s"><v>0</v></c>`;
      }
      yield text + '</row>';
    }
  };
}

interface Case {
  readonly name: string;
  readonly pieces: () => Iterable<string>;
  readonly expectRefusal: FileRefusal['code'] | null;
  /** The case's own header row, and shared strings, when it needs them. */
  readonly wide?: boolean;
  /** The refusal must come within this many milliseconds. */
  readonly maxMillis?: number;
}

const CASES: readonly Case[] = [
  { name: 'a 15 MiB sheet of 70,000 rows', pieces: manyRows, expectRefusal: 'file.too-many-rows' },
  {
    name: 'one row of 450,000 cells',
    pieces: oneWideRow,
    expectRefusal: 'file.too-many-columns',
  },
  { name: 'a big sheet within every limit', pieces: withinLimits, expectRefusal: null },
  {
    name: 'one 10,000-character shared string in 5,000 rows of 64 cells',
    pieces: reusedStringRows(5_000),
    expectRefusal: 'file.too-large',
    wide: true,
    maxMillis: 10_000,
  },
  {
    name: 'one 10,000-character shared string in 1,000 rows of 64 cells',
    pieces: reusedStringRows(1_000),
    expectRefusal: 'file.too-large',
    wide: true,
    maxMillis: 10_000,
  },
];

if (CASE !== undefined) {
  // The child: runs one case with the heap cap its parent gave it.
  describe('xlsx parse under a capped heap (child)', () => {
    it(`parses ${CASE}`, async () => {
      const found = CASES.find((candidate) => candidate.name === CASE);
      if (found === undefined) throw new Error(`no case ${CASE}`);
      const file =
        found.wide === true
          ? workbook(sheetOf(found.pieces(), WIDE_HEADER_ROW), SHARED_STRINGS_XML)
          : workbook(sheetOf(found.pieces()));
      // The file itself is within the upload limit: the refusal must come from the parse.
      if (found.wide === true) expect(file.length).toBeLessThanOrEqual(IMPORT_LIMITS.fileBytes);
      const started = Date.now();
      const result = await xlsxParser.parse(file, IMPORT_LIMITS);
      if (found.maxMillis !== undefined) {
        expect(Date.now() - started).toBeLessThan(found.maxMillis);
      }
      if (found.expectRefusal === null) {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.rowCount).toBe(IMPORT_LIMITS.rows);
      } else {
        expect(result).toMatchObject({ ok: false, error: { code: found.expectRefusal } });
      }
    }, 120_000);
  });
} else {
  describe(`xlsx parse under a ${HEAP_MIB} MiB heap (Hassan M-586-1)`, () => {
    const apiRoot = path.resolve(__dirname, '../../../../..');
    const jest = path.join(apiRoot, 'node_modules/jest/bin/jest.js');

    it.each(CASES.map((candidate) => [candidate.name]))(
      'completes or refuses cleanly: %s',
      (name) => {
        const run = spawnSync(
          process.execPath,
          [
            `--max-old-space-size=${HEAP_MIB}`,
            '--experimental-vm-modules',
            jest,
            '--runInBand',
            '--ci',
            '--testPathPatterns',
            'xlsx-import-heap\\.spec',
          ],
          {
            cwd: apiRoot,
            env: { ...process.env, XLSX_HEAP_CASE: name, NODE_NO_WARNINGS: '1' },
            encoding: 'utf8',
            timeout: 180_000,
          },
        );
        const output = `${run.stdout}\n${run.stderr}`;
        expect(output).not.toMatch(/heap out of memory|FATAL ERROR/i);
        expect([name, run.status, run.signal, output.slice(-600)]).toEqual([
          name,
          0,
          null,
          expect.anything(),
        ]);
      },
      200_000,
    );
  });
}
