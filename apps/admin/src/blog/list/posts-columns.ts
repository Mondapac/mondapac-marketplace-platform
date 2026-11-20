// The columns of the Blog posts list. Post and Status are always shown (a post's web address, its
// featured mark and the state of its newer version sit under its title) and so is Updated on, the
// column the list is read by; these are the ones an admin can show, hide and reorder. The choice
// is the admin's own and lives in this browser's storage. The export reads its own column ids
// (`POST_EXPORT_COLUMNS` of the API); `exportColumns` maps what is on screen to them.

import { cleanColumnIds } from '../../sales/columns.ts';

export const OPTIONAL_COLUMNS = ['kind', 'author', 'scheduled', 'published'] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly OptionalColumn[] = ['kind', 'author'];

/** The columns always shown, in their order. */
export const FIXED_COLUMNS = ['post', 'status', 'updated'] as const;

export const cleanColumns = (saved: readonly unknown[] | undefined): readonly OptionalColumn[] =>
  cleanColumnIds(saved, OPTIONAL_COLUMNS, DEFAULT_COLUMNS);

/** The optional columns of the API's export. */
type ExportColumn = 'slug' | 'stage' | 'featured' | 'scheduled' | 'published';

/**
 * The export columns for the columns on screen. The web address, the featured mark and the newer
 * version's state are always on screen (under the title), so the file always has them; the type
 * and the author are in every file. The go-live and published times follow the shown order.
 */
export function exportColumns(columns: readonly OptionalColumn[]): readonly ExportColumn[] {
  const out: ExportColumn[] = ['slug', 'featured', 'stage'];
  for (const column of columns)
    if (column === 'scheduled' || column === 'published') out.push(column);
  return [...new Set(out)];
}
