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
});

// The formula guard and the CSV line writer are the shared `@mondapac/platform-import` package
// (design 14b): the seller panel writes its variant file with the same code.
export { CSV_BOM, csvCell, csvLine } from '@mondapac/platform-import';
