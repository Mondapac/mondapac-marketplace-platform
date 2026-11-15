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

// The formula guard, the CSV line writer and the file chunks are shared: `@mondapac/platform-import`
// (design 14b) and platform/list-export (super list phase 0, B0-3).
export { CSV_BOM, csvCell, csvLine } from '@mondapac/platform-import';
export { csvChunks, textRows, type ExportCell } from '../../../../platform/list-export';
