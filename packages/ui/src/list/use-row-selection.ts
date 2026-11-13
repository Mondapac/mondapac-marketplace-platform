'use client';

import { useCallback, useEffect, useState } from 'react';

export interface RowSelectionState {
  readonly selected: ReadonlySet<string>;
  /** "Select all N in this filter" is on: every row of every page counts as selected. */
  readonly allMatching: boolean;
  /** No more rows can be ticked one by one (the cap of one request); ticked ones can be cleared. */
  readonly full: boolean;
  readonly toggleRow: (id: string) => void;
  /** The header box: tick every row of this page (up to the cap), or clear them. */
  readonly togglePage: (checked: boolean) => void;
  readonly selectAllMatching: () => void;
  readonly clear: () => void;
}

/**
 * The row selection of a list: ids ticked one by one up to `max`, or the whole filter after
 * "Select all in this filter". `resetKey` names the list (tab, search, filters, sort); another
 * list clears the selection, while paging keeps it so rows can be ticked on several pages.
 */
export function useRowSelection(
  pageIds: readonly string[],
  max: number,
  resetKey: string,
): RowSelectionState {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);

  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [resetKey]);

  const toggleRow = useCallback(
    (id: string) => {
      if (allMatching) {
        // Leaving "all in this filter": the rows of this page stay ticked, except this one.
        setAllMatching(false);
        setSelected(new Set(pageIds.filter((other) => other !== id)));
        return;
      }
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else if (next.size < max) next.add(id);
        return next;
      });
    },
    [allMatching, pageIds, max],
  );

  const togglePage = useCallback(
    (checked: boolean) => {
      if (allMatching) {
        if (!checked) {
          setAllMatching(false);
          setSelected(new Set());
        }
        return;
      }
      setSelected((current) => {
        const next = new Set(current);
        for (const id of pageIds) {
          if (!checked) next.delete(id);
          else if (next.size < max) next.add(id);
        }
        return next;
      });
    },
    [allMatching, pageIds, max],
  );

  const clear = useCallback(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, []);
  const selectAllMatching = useCallback(() => setAllMatching(true), []);

  return {
    selected,
    allMatching,
    full: !allMatching && selected.size >= max,
    toggleRow,
    togglePage,
    selectAllMatching,
    clear,
  };
}
