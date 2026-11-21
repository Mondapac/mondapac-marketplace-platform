'use client';

import { useEffect, useState } from 'react';

/**
 * The counts the built-in tabs show while a saved filter is open.
 *
 * A saved filter is a tab of its own, so it must not narrow the counts of the other tabs: the
 * list routes count "for the same search and filters" as the request, and the request of a saved
 * tab carries the saved filter. While `savedId` is null the live counts of the last answer are
 * used (search and filters typed by the user do narrow the tabs, by design). While a saved tab is
 * open, `load` reads the counts once more without any filter, and they stay until it closes.
 *
 * `load` is called once for each saved tab that opens; it must ask for the list's defaults (page
 * size 1 is enough) and resolve to the counts of the answer, or null when it could not read them.
 * It is read through a ref, so an inline function is fine.
 */
export function useBaseTabCounts<C>({
  savedId,
  live,
  load,
}: {
  readonly savedId: string | null;
  readonly live: C | null;
  readonly load: () => Promise<C | null>;
}): C | null {
  const [base, setBase] = useState<C | null>(null);
  const open = savedId !== null;
  // The latest `load` without making it a dependency (it is usually an inline closure).
  const [loadRef] = useState(() => ({ current: load }));
  loadRef.current = load;

  useEffect(() => {
    if (!open) {
      setBase(null);
      return;
    }
    let current = true;
    void loadRef.current().then((counts) => {
      if (current) setBase(counts);
    });
    return () => {
      current = false;
    };
  }, [open, loadRef]);

  return open ? base : live;
}
