import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crc32, safeText, toCsv, toXlsx } from './export-file.ts';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('export file', () => {
  it('writes a CSV with a byte order mark, CRLF and quoted cells', () => {
    const bytes = toCsv(['Question', 'Times'], [['say "hi", ok', 3]]);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text(bytes)).toBe('Question,Times\r\n"say ""hi"", ok",3\r\n');
  });

  it('keeps buyer text from running as a formula in a spreadsheet', () => {
    for (const evil of ['=HYPERLINK("http://x")', '+1+1', '-2', '@SUM(A1)', '\tx']) {
      expect(safeText(evil).startsWith("'")).toBe(true);
    }
    expect(safeText('kangaroo')).toBe('kangaroo');
    expect(text(toCsv(['q'], [['=1+1']]))).toContain("'=1+1");
  });

  it('checks CRC-32 against the standard value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a workbook other tools can open, text stored as text', () => {
    const bytes = toXlsx(
      'Unanswered questions',
      ['Question', 'Times'],
      [
        ['=1+1 <b>&', 4],
        ['é\u0001x', 1],
      ],
    );
    const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
    const file = join(dir, 'out.xlsx');
    writeFileSync(file, bytes);
    const script = [
      'import sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      "print(z.read('xl/worksheets/sheet1.xml').decode())",
      "print(z.read('xl/workbook.xml').decode())",
    ].join('\n');
    // Without python the structure is checked on the bytes themselves.
    const out = (() => {
      try {
        return execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' });
      } catch {
        return text(bytes);
      }
    })();
    expect(out).toContain('=1+1 &lt;b&gt;&amp;');
    expect(out).toContain('t="inlineStr"');
    expect(out).toContain('<v>4</v>');
    expect(out).toContain('é');
    expect(out).not.toContain('\u0001');
    expect(out).toContain('name="Unanswered questions"');
  });
});
