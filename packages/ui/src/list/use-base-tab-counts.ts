'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The counts the built-in tabs show while a saved filter is open.
 *
 * A saved filter is a tab of its own, so it must not narrow the counts of the other tabs: the
 * list routes count "for the same search and filters" as the request, and the request of a saved
 * tab carries the saved filter. While `savedId` is null the live counts of the last answer are
 * used (search and filters typed by the user do narrow the tabs, by design). While a saved tab is
 * open, `load` reads the counts once more without any filter, and they stay until it closes.
 *
 * `load` is called once each time a saved tab comes on show (the base counts are not refreshed by
 * changes made inside the saved tab: a recorded follow-up); it must ask for the list's defaults (page
 * size 1 is enough) and resolve to the counts of the answer, or null when it could not read them.
 * When the saved tab closes, the base counts stay until the live counts are another answer (the
 * new tab's own), so the narrowed numbers of the saved tab are never shown (this needs `live` to keep its identity
 * between renders). `load` is read through a ref, so an inline function is fine.
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
  // The live counts of the moment the saved tab closed: until they change they are the saved
  // tab's narrowed answer, not the new tab's.
  const closedOn = useRef<{ readonly live: C | null } | null>(null);
  const wasOpen = useRef(false);
  if (open) {
    closedOn.current = null;
  } else if (wasOpen.current) {
    closedOn.current = { live };
  }
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    let current = true;
    void loadRef
      .current()
      .then((counts) => {
        if (current) setBase(counts);
      })
      .catch(() => {
        if (current) setBase(null);
      });
    return () => {
      current = false;
    };
  }, [open, loadRef]);

  if (open) return base;
  if (closedOn.current !== null && closedOn.current.live === live) return base;
  return live;
}
