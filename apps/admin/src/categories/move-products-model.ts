import { indexOf, nameOf } from './tree-model.ts';
import type { CategoryRow, MoveJob, MoveProgressBody } from './types.ts';

// The pure part of "Move products…" (categories C5b): the targets (levels 3 and 4, hidden allowed)
// and how the progress read is understood. The API checks every rule again.

/** Products sit on level 3 and below; `depth` counts from 0 for a department. */
const LOWEST_PRODUCT_DEPTH = 2;

/**
 * The categories the products may go to: live (active or hidden; an admin may pick a hidden one),
 * on level 3 or 4, and not the category they leave. A category's own children are fine.
 */
export function moveTargetRows(
  rows: readonly CategoryRow[],
  sourceId: string,
): readonly CategoryRow[] {
  return rows.filter(
    (row) =>
      row.id !== sourceId &&
      row.depth >= LOWEST_PRODUCT_DEPTH &&
      (row.status === 'active' || row.status === 'hidden'),
  );
}

/** The job this dialog started, from the newest jobs of the category (null while it is not listed yet). */
export function jobOf(body: MoveProgressBody, jobId: string): MoveJob | null {
  return body.jobs.find((job) => job.id === jobId) ?? null;
}

/** The newest job still waiting or running (the list is newest first), or null. */
export function newestRunning(body: MoveProgressBody): MoveJob | null {
  return (
    [...body.jobs]
      .filter((job) => !isFinished(job))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0] ??
    null
  );
}

/** `Pantry › Rice › Sella`: the names from the department down to the category. */
export function pathLabel(rows: readonly CategoryRow[], id: string, locale: string): string {
  const { byId } = indexOf(rows);
  const names: string[] = [];
  let cursor = byId.get(id);
  for (let depth = 0; cursor !== undefined && depth < 8; depth += 1) {
    names.unshift(nameOf(cursor, locale));
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  return names.join(' › ');
}

/** Reads that find no job of ours in the newest list before the progress is called unreadable. */
export const MAX_MISSES = 5;

export const isFinished = (job: MoveJob): boolean => job.state === 'done' || job.state === 'failed';

/** Products handled so far; never shown above the total. */
export function handled(job: MoveJob): number {
  return Math.min(job.total, job.moved + job.skipped + job.failed);
}

/** How often the progress is read (milliseconds). */
export const POLL_MS = 2000;
