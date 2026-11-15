import { Workbook } from 'exceljs';
import { ExceljsSheetWriter } from './exceljs-sheet-writer';

// The customers export writes every cell as text: a value that starts like a formula must come
// back from the workbook as a string, never as a formula.

async function* rows(): AsyncGenerator<readonly string[]> {
  await Promise.resolve();
  yield ['Email', 'Name'];
  yield ['=cmd@example.test', '=HYPERLINK("http://x")'];
  yield ['+1@example.test', '@SUM(1)'];
}

describe('the customers XLSX writer', () => {
  it('writes formula-looking text as text cells', async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of new ExceljsSheetWriter().xlsx('Customers', rows())) {
      chunks.push(Buffer.from(chunk));
    }
    const workbook = new Workbook();
    await workbook.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Customers');
    expect(sheet).toBeDefined();
    const values = [2, 3].flatMap((r) => [1, 2].map((c) => sheet!.getRow(r).getCell(c).value));
    expect(values).toEqual([
      '=cmd@example.test',
      '=HYPERLINK("http://x")',
      '+1@example.test',
      '@SUM(1)',
    ]);
    for (const value of values) expect(typeof value).toBe('string');
  });
});
