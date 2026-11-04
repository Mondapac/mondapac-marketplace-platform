/**
 * Writes a spreadsheet file from rows of text. The application owns what the rows are; the
 * adapter (exceljs) owns the file format.
 */
export interface SheetWriter {
  /**
   * An `.xlsx` workbook with one sheet, as chunks of bytes, written while `rows` is read (the
   * first row is the header). **Every cell is written as a string value**, never as a number, date
   * or formula, so no cell can be run as a formula whatever it starts with. A failure of `rows`
   * or of the writer fails the returned iterable.
   */
  xlsx(sheetName: string, rows: AsyncIterable<readonly string[]>): AsyncIterable<Uint8Array>;
}

export const SHEET_WRITER = Symbol('CATALOG_SHEET_WRITER');

/** The content type of an `.xlsx` file. */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
