'use client';

import { useCallback, useEffect, useState } from 'react';

export interface SuperListQueryOptions<Q extends { readonly page: number }> {
  /** The query of a list that has just opened on its first built-in tab. */
  readonly defaultQuery: Q;
  /** The query of a built-in tab opened from a saved tab: the defaults of the list, on that tab. */
  readonly forView: (view: string) => Q;
  /** The same query on another built-in tab, filters, search and sort kept (no saved tab on show). */
  readonly withView: (query: Q, view: string) => Q;
  readonly searchOf: (query: Q) => string;
  readonly withSearch: (query: Q, search: string) => Q;
  /** Typing searches after this pause (ms); Enter does not wait. */
  readonly searchDelayMs?: number;
}

export interface SuperListQuery<Q> {
  readonly query: Q;
  /** What is typed in the search box (it can be ahead of `query`). */
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  /** The saved tab on show, or null on a built-in tab or a list nobody saved. */
  readonly savedId: string | null;
  /** Any change of search, filters or sort leaves the saved tab (it is no longer it). */
  readonly change: (patch: Partial<Q>) => void;
  /** Paging keeps the tab, the saved tab included. */
  readonly goToPage: (page: number) => void;
  /** A built-in tab. Opened from a saved tab it starts clean: see `useSuperListQuery`. */
  readonly openView: (view: string) => void;
  /** A saved tab; `next` is the query its payload holds. */
  readonly openSaved: (id: string, next: Q) => void;
  /** The saved tab was deleted: the list stays as it is, as a list nobody saved. */
  readonly forgetSaved: () => void;
  /** Clears the search box and the search and filters of the query. */
  readonly reset: (patch: Partial<Q>) => void;
}

/**
 * The query state of a super list, with the rule that a saved filter belongs to its own tab:
 * opening a built-in tab from a saved tab never carries the saved filter's search, filters, sort,
 * days or columns over, it starts from the list's defaults. Pages used to repeat this by hand and
 * got it wrong (admin and seller Orders); this is the one place that has it, tested once.
 */
export function useSuperListQuery<Q extends { readonly page: number }>({
  defaultQuery,
  forView,
  withView,
  searchOf,
  withSearch,
  searchDelayMs = 300,
}: SuperListQueryOptions<Q>): SuperListQuery<Q> {
  const [query, setQuery] = useState<Q>(defaultQuery);
  const [draft, setDraft] = useState(searchOf(defaultQuery));
  const [savedId, setSavedId] = useState<string | null>(null);
  const searched = searchOf(query);

  const change = useCallback((patch: Partial<Q>) => {
    setSavedId(null);
    setQuery((current) => ({ ...current, page: 1, ...patch }));
  }, []);

  const goToPage = useCallback((page: number) => {
    setQuery((current) => ({ ...current, page }));
  }, []);

  const openView = useCallback(
    (view: string) => {
      if (savedId !== null) {
        setSavedId(null);
        setDraft(searchOf(forView(view)));
        setQuery(forView(view));
      } else {
        setQuery((current) => ({ ...withView(current, view), page: 1 }));
      }
    },
    [savedId, forView, withView, searchOf],
  );

  const openSaved = useCallback(
    (id: string, next: Q) => {
      setSavedId(id);
      setDraft(searchOf(next));
      setQuery(next);
    },
    [searchOf],
  );

  const forgetSaved = useCallback(() => setSavedId(null), []);

  const reset = useCallback((patch: Partial<Q>) => {
    setSavedId(null);
    setDraft('');
    setQuery((current) => ({ ...current, page: 1, ...patch }));
  }, []);

  // Typing searches after a short pause.
  useEffect(() => {
    if (draft.trim() === searched) return undefined;
    const timer = setTimeout(() => {
      setSavedId(null);
      setQuery((current) => ({ ...withSearch(current, draft.trim()), page: 1 }));
    }, searchDelayMs);
    return () => clearTimeout(timer);
  }, [draft, searched, searchDelayMs, withSearch]);

  return {
    query,
    draft,
    setDraft,
    savedId,
    change,
    goToPage,
    openView,
    openSaved,
    forgetSaved,
    reset,
  };
}
