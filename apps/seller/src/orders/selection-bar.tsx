'use client';

import { Button } from '@mondapac/ui';

export interface SelectionBarLabels {
  /** "3 orders selected". */
  readonly selected: string;
  /** "All 143 matching orders are selected" (with Previous and next, no number). */
  readonly all: string;
  /** "Select all 143 matching" (with Previous and next, "Select all matching"). */
  readonly selectAll: string;
  readonly clear: string;
}

/**
 * The bar over the orders list while rows are selected: how many, "Select all N matching" once the
 * whole page is ticked and more rows match, and Clear selection. The count is announced. The page
 * words everything.
 */
export function SelectionBar({
  active,
  allMatching,
  canSelectAll,
  labels,
  onSelectAll,
  onClear,
}: {
  /** Something is selected: rows ticked one by one, or the whole filter. */
  readonly active: boolean;
  readonly allMatching: boolean;
  /** The whole page is ticked and more rows match than it holds. */
  readonly canSelectAll: boolean;
  readonly labels: SelectionBarLabels;
  readonly onSelectAll: () => void;
  readonly onClear: () => void;
}) {
  if (!active) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-muted px-4 py-2 text-sm">
      <p role="status" aria-live="polite" className="font-medium text-fg">
        {allMatching ? labels.all : labels.selected}
      </p>
      {!allMatching && canSelectAll ? (
        <Button variant="link" size="sm" onClick={onSelectAll}>
          {labels.selectAll}
        </Button>
      ) : null}
      <Button variant="link" size="sm" onClick={onClear}>
        {labels.clear}
      </Button>
    </div>
  );
}
