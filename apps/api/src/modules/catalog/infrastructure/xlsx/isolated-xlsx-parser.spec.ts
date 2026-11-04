import { randomInt } from 'node:crypto';
import {
  contentTypesXml,
  MAIN_TYPE,
  workbookBytes,
  zipOf,
} from '../../../../../test/support/zip-fixtures';
import path from 'node:path';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import {
  createIsolatedXlsxParser,
  xlsxParseRunning,
  XLSX_WORKER_LIMITS,
} from './isolated-xlsx-parser';
import { createXlsxParser } from './xlsx-import-parser';

// Hassan M-586-8 (round 4): the whole XLSX parse runs in a worker thread with a heap cap and a time
// limit, one at a time. These specs start the REAL worker (no fake): every failure the thread can
// have is a refusal, the API's thread is never blocked, and the files that cost hours of CPU or
// gigabytes of memory in the reviews are refused without touching this thread.

const WORKBOOK_XML =
  '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
  '<sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELS_XML =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
const sheetOf = (body: string): Buffer =>
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`,
  );
/** Stored parts by default, so that size and not the compression ratio is what a file tests. */
const workbookOf = (sheet: Buffer, sharedStrings?: Buffer, method: 0 | 8 = 0): Buffer =>
  zipOf([
    { name: '[Content_Types].xml', data: contentTypesXml(MAIN_TYPE) },
    { name: 'xl/workbook.xml', data: Buffer.from(WORKBOOK_XML) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(RELS_XML) },
    ...(sharedStrings === undefined
      ? []
      : [{ name: 'xl/sharedStrings.xml', data: sharedStrings, method }]),
    { name: 'xl/worksheets/sheet1.xml', data: sheet, method },
  ]);

const columnName = (index: number): string => {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
};

/** Hassan's file M-586-8: a shared string of 1,000,000 empty runs, used by 60 x 128 cells. */
function emptyRunsFile(): Buffer {
  const strings = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">' +
      `<si>${'<r/>'.repeat(1_000_000)}</si></sst>`,
  );
  const rows = Array.from({ length: 60 }, (_, i) => {
    const n = i + 2;
    const cells = Array.from(
      { length: 128 },
      (_x, c) => `<c r="${columnName(c)}${n}" t="s"><v>0</v></c>`,
    );
    return `<row r="${n}">${cells.join('')}</row>`;
  }).join('');
  return workbookOf(
    sheetOf(`<row r="1"><c r="A1" t="inlineStr"><is><t>Title</t></is></c></row>${rows}`),
    strings,
  );
}

/**
 * The biggest sheet that is within every limit: 5,000 data rows of 64 cells, each its own random
 * shared string (16 characters), so the worker holds 320,000 strings and 320,000 cells.
 */
function fullSizeFile(): Buffer {
  const strings: string[] = [];
  const header = Array.from(
    { length: IMPORT_LIMITS.columns },
    (_, c) => `<c r="${columnName(c)}1" t="inlineStr"><is><t>Column ${c + 1}</t></is></c>`,
  );
  const parts: string[] = [`<row r="1">${header.join('')}</row>`];
  for (let n = 2; n <= IMPORT_LIMITS.rows + 1; n += 1) {
    let row = `<row r="${n}">`;
    for (let c = 0; c < IMPORT_LIMITS.columns; c += 1) {
      strings.push(
        `<si><t>${randomInt(1e9, 9e9).toString(36)}${randomInt(1e9, 9e9).toString(36)}</t></si>`,
      );
      row += `<c r="${columnName(c)}${n}" t="s"><v>${strings.length - 1}</v></c>`;
    }
    parts.push(row + '</row>');
  }
  const sst = Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.join('')}</sst>`,
  );
  return workbookOf(sheetOf(parts.join('')), sst, 8);
}

describe('isolated xlsx parser (a real worker thread)', () => {
  const parser = createIsolatedXlsxParser();

  // One parse at a time is process-wide. A spec that fails before its parse settles (a timeout)
  // must not hand the next spec a parse that is still running, which it would read as `file.busy`:
  // each spec starts only once the last parse has ended (it always does, by the time limit).
  afterEach(async () => {
    while (xlsxParseRunning()) await new Promise((resolve) => setTimeout(resolve, 20));
  }, 30_000);

  it('gives the same table as the parse in this thread, canonical CSV included', async () => {
    const bytes = await workbookBytes([
      ['Title', 'Brand', 'Code'],
      ['Beef', 'Farms', 12],
      ['Lamb', '', 'x,"y"'],
    ]);
    const inside = await createXlsxParser().parse(bytes, IMPORT_LIMITS);
    const isolated = await parser.parse(bytes, IMPORT_LIMITS);
    expect(isolated.ok).toBe(true);
    expect(isolated).toEqual(inside);
    if (isolated.ok) expect(isolated.value.canonical?.length).toBeGreaterThan(0);
    expect(xlsxParseRunning()).toBe(false);
  });

  it('passes a refusal of the parse on unchanged', async () => {
    const formula = await workbookBytes([['Title'], [{ formula: 'SUM(1,2)', result: 3 }]]);
    const refusedInside = await createXlsxParser().parse(formula, IMPORT_LIMITS);
    expect(refusedInside).toEqual({
      ok: false,
      error: { code: 'file.formula-cell', rowNumber: 2 },
    });
    expect(await parser.parse(formula, IMPORT_LIMITS)).toEqual(refusedInside);
    const notAZip = Buffer.from('PK\u0003\u0004 not a zip');
    const refused = await createXlsxParser().parse(notAZip, IMPORT_LIMITS);
    expect(refused.ok).toBe(false);
    expect(await parser.parse(notAZip, IMPORT_LIMITS)).toEqual(refused);
  });

  it('refuses the empty-runs file (60 x 128 cells) cleanly and fast', async () => {
    // The clock starts once the file is built: it times the parse, not the test's own setup.
    const bytes = emptyRunsFile();
    const started = Date.now();
    const result = await parser.parse(bytes, IMPORT_LIMITS);
    expect(result).toEqual({ ok: false, error: { code: 'file.too-complex' } });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reads a file at every limit within the heap cap (5,000 rows of 64 cells)', async () => {
    const bytes = fullSizeFile();
    expect(bytes.length).toBeLessThan(IMPORT_LIMITS.fileBytes);
    const result = await parser.parse(bytes, IMPORT_LIMITS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rowCount).toBe(IMPORT_LIMITS.rows);
  }, 60_000);

  it('does not block this thread while it parses', async () => {
    const bytes = fullSizeFile();
    let last = Date.now();
    let longest = 0;
    const tick = setInterval(() => {
      const now = Date.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 10);
    try {
      const result = await parser.parse(bytes, IMPORT_LIMITS);
      expect(result.ok).toBe(true);
    } finally {
      clearInterval(tick);
    }
    // The parse takes seconds; this thread only copies the bytes in and the table out.
    expect(longest).toBeLessThan(750);
  }, 60_000);

  describe('every way the thread can fail is a refusal', () => {
    /** 700,000 distinct shared strings (the part is under its 15 MiB limit): a small file. */
    const manyStrings = (): Buffer => {
      const strings = Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          Array.from({ length: 700_000 }, (_, i) => `<si><t>s${i.toString(36)}</t></si>`).join('') +
          '</sst>',
      );
      const bytes = workbookOf(
        sheetOf(
          '<row r="1"><c r="A1" t="inlineStr"><is><t>Title</t></is></c></row><row r="2"><c r="A2" t="s"><v>5</v></c></row>',
        ),
        strings,
        8,
      );
      expect(bytes.length).toBeLessThan(IMPORT_LIMITS.fileBytes);
      return bytes;
    };
    const tooLarge = {
      ok: false,
      error: { code: 'file.too-large', maxBytes: IMPORT_LIMITS.fileBytes },
    };

    it('out of memory is file.too-large', async () => {
      const bytes = manyStrings();
      const small = createIsolatedXlsxParser({
        resourceLimits: { ...XLSX_WORKER_LIMITS, maxOldGenerationSizeMb: 32 },
      });
      expect(await small.parse(bytes, IMPORT_LIMITS)).toEqual(tooLarge);
      expect(xlsxParseRunning()).toBe(false);
    }, 60_000);

    // A process started with --max-old-space-size makes V8 ignore the thread's resourceLimits, so
    // the parent also watches the heap: here the limits are huge and only the watch can end it.
    it('a thread holding more heap than its watch allows is ended: file.too-large', async () => {
      const watched = createIsolatedXlsxParser({
        resourceLimits: { maxOldGenerationSizeMb: 4096, maxYoungGenerationSizeMb: 32 },
        heapWatchMb: 20,
      });
      expect(await watched.parse(manyStrings(), IMPORT_LIMITS)).toEqual(tooLarge);
      expect(xlsxParseRunning()).toBe(false);
    }, 60_000);

    it('passing the time limit ends the thread: file.too-complex', async () => {
      const impatient = createIsolatedXlsxParser({ timeoutMs: 50 });
      const bytes = fullSizeFile();
      const started = Date.now();
      const result = await impatient.parse(bytes, IMPORT_LIMITS);
      expect(result).toEqual({ ok: false, error: { code: 'file.too-complex' } });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(xlsxParseRunning()).toBe(false);
    }, 60_000);

    it('a thread that ends without an answer is file.unreadable', async () => {
      const crashing = createIsolatedXlsxParser({
        entry: path.resolve(__dirname, '../../../../../test/support/crashing-xlsx-worker.ts'),
      });
      const result = await crashing.parse(await workbookBytes([['Title']]), IMPORT_LIMITS);
      expect(result).toEqual({ ok: false, error: { code: 'file.unreadable' } });
      expect(xlsxParseRunning()).toBe(false);
    });

    it('an error the thread raises after the time limit does not escape (L-586-9)', async () => {
      const late = createIsolatedXlsxParser({
        timeoutMs: 20,
        entry: path.resolve(__dirname, '../../../../../test/support/late-throwing-xlsx-worker.ts'),
      });
      const parsing = late.parse(await workbookBytes([['Title']]), IMPORT_LIMITS);
      // Hold this thread past both the time limit and the thread's throw (its start-up included),
      // so the timeout settles first and the error event comes after the listeners are gone.
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        // Busy on purpose.
      }
      expect(await parsing).toEqual({ ok: false, error: { code: 'file.too-complex' } });
      // Give a late 'error' event the chance to surface as an uncaught exception.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(xlsxParseRunning()).toBe(false);
    }, 30_000);

    it('a thread that cannot be started is file.unreadable', async () => {
      const missing = createIsolatedXlsxParser({
        entry: '/nonexistent/xlsx-worker.ts',
      });
      const result = await missing.parse(await workbookBytes([['Title']]), IMPORT_LIMITS);
      expect(result).toEqual({ ok: false, error: { code: 'file.unreadable' } });
    });
  });

  it('runs one parse at a time: a second meanwhile is file.busy, then the next goes through', async () => {
    const bytes = await workbookBytes([['Title'], ['x']]);
    const first = parser.parse(bytes, IMPORT_LIMITS);
    expect(xlsxParseRunning()).toBe(true);
    const second = await parser.parse(bytes, IMPORT_LIMITS);
    expect(second).toEqual({ ok: false, error: { code: 'file.busy', retryAfterSeconds: 5 } });
    expect((await first).ok).toBe(true);
    expect(xlsxParseRunning()).toBe(false);
    expect((await parser.parse(bytes, IMPORT_LIMITS)).ok).toBe(true);
  });
});
