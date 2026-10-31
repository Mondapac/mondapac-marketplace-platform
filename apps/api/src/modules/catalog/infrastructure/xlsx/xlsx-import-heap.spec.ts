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

/** A workbook whose sheet is STORED (ratio 1), so that size, not compression, is what is tested. */
function workbook(sheet: Buffer): Buffer {
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';
  return zipOf([
    { name: '[Content_Types].xml', data: contentTypesXml(MAIN_TYPE) },
    { name: 'xl/workbook.xml', data: Buffer.from(WORKBOOK_XML) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(rels) },
    { name: 'xl/worksheets/sheet1.xml', data: sheet, method: 0 },
  ]);
}

/** Rows built piece by piece into Buffers, so the test itself holds almost nothing on the heap. */
function sheetOf(pieces: Iterable<string>): Buffer {
  const parts: Buffer[] = [Buffer.from(SHEET_HEAD + HEADER_ROW)];
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

interface Case {
  readonly name: string;
  readonly pieces: () => Iterable<string>;
  readonly expectRefusal: FileRefusal['code'] | null;
}

const CASES: readonly Case[] = [
  { name: 'a 15 MiB sheet of 70,000 rows', pieces: manyRows, expectRefusal: 'file.too-many-rows' },
  {
    name: 'one row of 450,000 cells',
    pieces: oneWideRow,
    expectRefusal: 'file.too-many-columns',
  },
  { name: 'a big sheet within every limit', pieces: withinLimits, expectRefusal: null },
];

if (CASE !== undefined) {
  // The child: runs one case with the heap cap its parent gave it.
  describe('xlsx parse under a capped heap (child)', () => {
    it(`parses ${CASE}`, async () => {
      const found = CASES.find((candidate) => candidate.name === CASE);
      if (found === undefined) throw new Error(`no case ${CASE}`);
      const file = workbook(sheetOf(found.pieces()));
      const result = await xlsxParser.parse(file, IMPORT_LIMITS);
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
