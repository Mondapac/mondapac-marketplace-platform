'use client';

import type { ReactNode } from 'react';
import { CARD_TABLE } from '../data/card-table.ts';
import { useDelayedLoading } from '../loading/use-delayed-loading.ts';

/**
 * Panel loading L2: the super list's loading states (panel-loading plan, option B).
 *
 * - First load: the list's own table (its real header, the select-all box disabled) with skeleton
 *   rows in the shape of its visible columns, at most {@link LIST_SKELETON_MAX_ROWS} rows. Below
 *   1024 px the same rows become skeleton cards, because they carry the table's CARD_TABLE classes.
 * - Refresh (another filter, sort or page): the rows already on screen stay at 60 % with a 2 px bar
 *   at the top of the list; no skeleton again.
 * Both wait 200 ms before they show and stay at least 400 ms ({@link useDelayedLoading}).
 */

/** A list never shows more skeleton rows than this, whatever its page size. */
export const LIST_SKELETON_MAX_ROWS = 10;

/** How many skeleton rows a list with this page size shows. */
export function listSkeletonRowCount(pageSize: number): number {
  return Math.max(1, Math.min(Math.floor(pageSize), LIST_SKELETON_MAX_ROWS));
}

/**
 * The shape of one column's placeholder:
 * - `select`: the row's check box.
 * - `thumb`: a photo square with the title and a short second line (a product cell).
 * - `title`: the title and a short second line, without a photo.
 * - `text`: one long bar. `date`: a medium bar. `number`: a short bar at the end of the cell.
 * - `status`: a pill, the size of a Badge.
 */
export type ListSkeletonKind = 'select' | 'thumb' | 'title' | 'text' | 'date' | 'number' | 'status';

export interface ListSkeletonCell {
  readonly kind: ListSkeletonKind;
  /** The same class names as the real cell of this column, so widths and the card layout match. */
  readonly className?: string;
  /** The column name; a labelled cell shows it on the card below 1024 px (`data-label`). */
  readonly label?: string;
}

// A bar sits in a 20 px line (the height of text-sm), so a skeleton row is as tall as a real one.
const BAR = 'block h-3 rounded-sm bg-muted';

function Line({ width, end = false }: { readonly width: string; readonly end?: boolean }) {
  return (
    <span className={`flex h-5 items-center ${end ? 'justify-end' : ''}`}>
      <span className={`${BAR} ${width}`} />
    </span>
  );
}

function TitleLines() {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <Line width="w-4/5 max-w-56" />
      <span className="flex h-4 items-center">
        <span className="block h-2.5 w-2/5 max-w-24 rounded-sm bg-muted" />
      </span>
    </span>
  );
}

/** The placeholder for one cell. Decoration only: the list's status names what is loading. */
export function ListSkeletonContent({ kind }: { readonly kind: ListSkeletonKind }): ReactNode {
  switch (kind) {
    case 'select':
      return <span data-skeleton="select" className="block size-4 rounded-sm bg-muted" />;
    case 'thumb':
      return (
        <span data-skeleton="thumb" className="flex min-w-0 items-center gap-3">
          <span className="block size-10 shrink-0 rounded-md bg-muted" />
          <TitleLines />
        </span>
      );
    case 'title':
      return (
        <span data-skeleton="title" className="flex min-w-0">
          <TitleLines />
        </span>
      );
    case 'text':
      return (
        <span data-skeleton="text" className="contents">
          <Line width="w-28 max-w-full" />
        </span>
      );
    case 'date':
      return (
        <span data-skeleton="date" className="contents">
          <Line width="w-20 max-w-full" />
        </span>
      );
    case 'number':
      return (
        <span data-skeleton="number" className="contents">
          <Line width="w-10" end />
        </span>
      );
    case 'status':
      return <span data-skeleton="status" className="block h-5 w-16 rounded-full bg-muted" />;
  }
}

/**
 * Skeleton rows for a CARD_TABLE body, one cell per visible column. Put them in the list's own
 * `<tbody>` in place of its rows, so the header above stays the real one. Hidden from screen
 * readers; the list's {@link ListLoadingStatus} says what is loading.
 */
export function ListSkeletonRows({
  cells,
  rows,
}: {
  readonly cells: readonly ListSkeletonCell[];
  readonly rows: number;
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, index) => (
        <tr
          key={index}
          aria-hidden="true"
          data-testid="skeleton-row"
          className={`${CARD_TABLE.row} max-lg:relative motion-safe:animate-pulse`}
        >
          {cells.map((cell, column) => (
            <td key={column} className={cell.className ?? CARD_TABLE.cell} data-label={cell.label}>
              <ListSkeletonContent kind={cell.kind} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

/**
 * The one live region of a list that is loading: its name for screen readers ("Loading
 * products"), and after 10 s "Still loading…" for everyone.
 */
export function ListLoadingStatus({
  label,
  slow,
  slowLabel,
}: {
  readonly label: string;
  readonly slow: boolean;
  readonly slowLabel: string;
}) {
  return (
    <p role="status" className={slow ? 'text-sm text-fg-muted' : 'sr-only'}>
      {slow ? slowLabel : label}
    </p>
  );
}

/**
 * The rows of a list while another page, sort or filter loads: they stay at 60 % with a 2 px bar
 * at the top of the list, and the list is marked busy. With reduced motion the bar stands still.
 */
export function ListRefreshing({
  refreshing,
  busy = refreshing,
  children,
}: {
  readonly refreshing: boolean;
  /** Mark the content busy (aria-busy); also while its skeleton rows show. Defaults to `refreshing`. */
  readonly busy?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="relative">
      <div
        aria-busy={busy}
        className={refreshing ? 'opacity-60 transition-opacity' : 'transition-opacity'}
      >
        {children}
      </div>
      {refreshing ? (
        <div
          aria-hidden="true"
          data-testid="list-refresh-bar"
          className="mp-list-refresh pointer-events-none absolute inset-x-px top-px h-0.5 overflow-hidden rounded-t-lg"
        >
          <div className="mp-list-refresh-bar" />
        </div>
      ) : null}
    </div>
  );
}

export interface ListLoading {
  /** Show the skeleton rows: the first load has run past 200 ms (and holds at least 400 ms). */
  readonly skeleton: boolean;
  /** The first load has run past 10 s: add "Still loading…". */
  readonly slow: boolean;
  /** The first load has run past 30 s: show the load error with Try again instead. */
  readonly stalled: boolean;
  /** Dim the rows on screen and show the bar: a later load has run past 200 ms. */
  readonly refreshing: boolean;
}

/**
 * What a super list shows while it loads. `hasRows` is true once a page has arrived: from then on
 * a load is a refresh (rows dim), never a skeleton again.
 */
export function useListLoading(loading: boolean, hasRows: boolean): ListLoading {
  const first = useDelayedLoading(loading && !hasRows);
  const refresh = useDelayedLoading(loading && hasRows);
  return {
    skeleton: first.visible,
    slow: first.slow,
    stalled: first.stalled,
    refreshing: refresh.visible && !first.visible,
  };
}
