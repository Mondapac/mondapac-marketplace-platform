// No 'use client': server components (the panel dashboards) call this while building a
// skeleton's props. A function exported from a 'use client' module becomes a client reference
// on the server and cannot be called there.
import type { ActivityColumn } from './activity-table.tsx';

/** A column of an ActivityTable without its cells: what its skeleton needs. */
export type ActivitySkeletonColumn = Pick<
  ActivityColumn<unknown>,
  'id' | 'header' | 'kind' | 'size' | 'align'
>;

/** The columns of an ActivityTable as its skeleton takes them (cell functions cannot reach a client component). */
export function activitySkeletonColumns(
  columns: readonly ActivityColumn<never>[],
): ActivitySkeletonColumn[] {
  return columns.map(({ id, header, kind, size, align }) => ({
    id,
    header,
    kind,
    ...(size === undefined ? {} : { size }),
    ...(align === undefined ? {} : { align }),
  }));
}
