import type { ImportJob, ImportRowRecord } from '../../domain/platform-import/platform-import-job';
import { errorReportCsv, fullReportCsv, problemText, templateCsv } from './import-report';

const row = (overrides: Partial<ImportRowRecord>): ImportRowRecord => ({
  rowNumber: 2,
  checkState: 'error',
  issues: [],
  summary: { title: 'T', category: 'C', typeCode: 'simple', brand: 'B' },
  runState: 'skipped',
  runCode: null,
  productId: null,
  productCode: null,
  ...overrides,
});

describe('the platform import reports', () => {
  it('writes a leading quote before a cell a spreadsheet would run as a formula', () => {
    const csv = errorReportCsv([
      row({
        issues: [
          { severity: 'error', column: 'title', code: 'too-long', value: '=HYPERLINK("http://x")' },
          { severity: 'error', column: 'brand', code: 'too-long', value: '@SUM(1)' },
          { severity: 'error', column: 'unitSize', code: 'too-long', value: '+1' },
          { severity: 'error', column: 'gtin', code: 'gtin.length', value: '-2' },
        ],
      }),
    ]);
    for (const cell of ['=HYPERLINK', '@SUM', '+1', '-2']) {
      expect(csv).not.toMatch(new RegExp(`(^|,)"?${cell.replace(/[+(]/g, '\\$&')}`, 'm'));
      expect(csv).toContain(`'${cell}`);
    }
  });

  it('keeps the error report to rows with problems and never carries the file name', () => {
    const csv = errorReportCsv([
      row({ issues: [{ severity: 'error', column: 'title', code: 'required', value: '' }] }),
    ]);
    expect(csv.split('\n').length).toBeGreaterThanOrEqual(2);
    expect(csv).toContain('Title is required');
  });

  it('writes the full report with the run result of each row', () => {
    const job = { state: 'finished' } as ImportJob;
    const csv = fullReportCsv(job, [
      row({ checkState: 'ready', runState: 'added', productCode: 'P00000001' }),
      row({ rowNumber: 3, checkState: 'ready', runState: 'failed', runCode: 'claim-text.found' }),
    ]);
    expect(csv).toContain('P00000001');
    expect(csv).toContain('Not imported');
    expect(csv).toContain('Certification belongs to a seller');
  });

  it('describes every code with words, never a code, for a known problem', () => {
    expect(problemText('category.unknown', 'category')).toMatch(/category/i);
    expect(problemText('duplicate-in-file', 'title', 4)).toContain('row 4');
  });

  it('builds the template as CSV', () => {
    expect(
      templateCsv([
        ['A', 'B'],
        ['1', '2'],
      ]),
    ).toContain('A,B');
  });
});
