import type { SellerRowRecord } from '../../domain/seller-import/seller-import-job';
import {
  sellerErrorReportCsv,
  sellerFullReportCsv,
  sellerProblemText,
  sellerTemplateCsv,
  sellerTemplateRows,
} from './seller-import-report';

// The seller import's reports (catalog design 14c): a cell a spreadsheet would run as a formula gets
// a leading quote, the words are plain, and the template reads no price, stock or Cost column.

const row = (over: Partial<SellerRowRecord>): SellerRowRecord => ({
  rowNumber: 2,
  groupRow: 2,
  checkState: 'error',
  plan: null,
  issues: [],
  summary: {
    sku: 'SKU-1',
    title: 'T',
    productCode: '',
    typeCode: 'simple',
    options: '',
    images: [],
  },
  runState: 'skipped',
  runCode: null,
  productId: null,
  offerId: null,
  productCode: null,
  ...over,
});

describe('the seller import reports', () => {
  it('writes a leading quote before a cell a spreadsheet would run as a formula', () => {
    const csv = sellerErrorReportCsv([
      row({
        issues: [
          { severity: 'error', column: 'title', code: 'too-long', value: '=HYPERLINK("http://x")' },
          { severity: 'error', column: 'brand', code: 'too-long', value: '@SUM(1)' },
          { severity: 'error', column: 'gtin', code: 'gtin.length', value: '-2' },
          { severity: 'error', column: 'sku', code: 'too-long', value: '+1' },
        ],
      }),
    ]);
    for (const cell of ['=HYPERLINK', '@SUM', '+1', '-2']) {
      expect(csv).toContain(`'${cell}`);
    }
  });

  it('guards the SKU and the title of the full report too', () => {
    const csv = sellerFullReportCsv({ state: 'finished' }, [
      row({
        checkState: 'ready',
        runState: 'created',
        summary: {
          sku: '=1+1',
          title: '@cmd',
          productCode: '',
          typeCode: 'simple',
          options: '',
          images: [],
        },
        productCode: 'P00000001',
      }),
    ]);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'@cmd");
    expect(csv).toContain('Created');
    expect(csv).toContain('P00000001');
  });

  it('lists only the errors in the error report and says what failed in the full one', () => {
    const errors = sellerErrorReportCsv([
      row({
        issues: [
          { severity: 'error', column: 'title', code: 'required', value: '' },
          { severity: 'warning', column: 'brand', code: 'unknown', value: 'x' },
        ],
      }),
      row({ rowNumber: 3, checkState: 'ready', issues: [] }),
    ]);
    expect(errors.trim().split('\n')).toHaveLength(2);
    const full = sellerFullReportCsv({ state: 'stopped' }, [
      row({ checkState: 'ready', runState: 'failed', runCode: 'seller.not-eligible' }),
      row({ rowNumber: 3, checkState: 'ready', runState: 'pending' }),
    ]);
    expect(full).toContain('Not imported');
    expect(full).toContain('Not tried');
  });

  it('describes a known problem in words', () => {
    expect(sellerProblemText('duplicate-in-file', 'sku', 4)).toContain('row 4');
  });

  it('builds a template per mode that has no price, stock or cost column', () => {
    for (const mode of ['my-products', 'sell-from-catalogue'] as const) {
      const rows = sellerTemplateRows(mode, 'simple');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.join(',').toLowerCase()).not.toMatch(/price|stock|cost/);
      expect(rows[0]).toContain('Seller SKU');
      expect(sellerTemplateCsv(rows)).toContain('Seller SKU');
    }
  });
});
