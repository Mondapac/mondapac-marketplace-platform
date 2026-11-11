import { CSV_BOM, csvLine } from '@mondapac/platform-import';

// The CSV of the admin product export (catalog design 9.2c): pure text functions, no I/O.

/** The optional columns of the list, as the page's column picker names them. */
export const EXPORT_COLUMNS = [
  'code',
  'offers',
  'updated',
  'type',
  'scope',
  'seller',
  'created',
  'tags',
] as const;
export type ExportColumn = (typeof EXPORT_COLUMNS)[number];

/** The header of each column (English; the file is data, not a page). */
export const EXPORT_HEADERS: Readonly<
  Record<ExportColumn | 'name' | 'category' | 'status', string>
> = Object.freeze({
  name: 'Product',
  code: 'Product code',
  category: 'Category',
  status: 'Status',
  offers: 'Offers',
  updated: 'Last changed',
  type: 'Product type',
  scope: 'Scope',
  seller: 'Seller',
  created: 'Created',
  tags: 'Tags',
});

// The formula guard and the CSV line writer are the shared `@mondapac/platform-import` package
// (design 14b): the seller panel writes its variant file with the same code.
export { CSV_BOM, csvCell, csvLine } from '@mondapac/platform-import';

/** One cell of a row before it is written: text, a count or nothing. */
export type ExportCell = string | number | null;

/** CSV: the byte order mark before the header, then each group of rows as one chunk of lines. */
export async function* csvChunks(
  groups: AsyncIterable<readonly (readonly ExportCell[])[]>,
): AsyncGenerator<string> {
  let first = true;
  for await (const group of groups) {
    const text = group.map((row) => csvLine(row)).join('');
    yield first ? CSV_BOM + text : text;
    first = false;
  }
}

/** XLSX: every cell as text; a count is written as the digits, nothing is a number or formula. */
export async function* textRows(
  groups: AsyncIterable<readonly (readonly ExportCell[])[]>,
): AsyncGenerator<readonly string[]> {
  for await (const group of groups) {
    for (const row of group) yield row.map((cell) => (cell === null ? '' : String(cell)));
  }
}
