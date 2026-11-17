// The saved filters of the three Sales lists (Shipments, Refunds, Invoices), through the generic
// routes of the lists module (`lists/admin/saved-filters`). Each list defines its own closed
// payload (`*-saved.ts`); the request shapes, the reading of the answer and the words of a
// refusal are the same for all three, so they live here.

import type { SavedViewProblem, SavedViewVisibility } from '@mondapac/ui';
import { useCallback, useEffect, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';

/** The limits the server enforces (MAX per owner and shared); the answer names no limit. */
export const SAVED_LIMITS = { perOwner: 50, shared: 20 } as const;

export interface SavedFilter<P> {
  readonly id: string;
  readonly listKey: string;
  readonly name: string;
  readonly visibility: SavedViewVisibility;
  readonly payload: P;
  readonly ownedByMe: boolean;
  readonly canManage: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SavedFiltersAnswer<P> {
  readonly items: readonly SavedFilter<P>[];
  /** Whether this admin holds the list's share permission (`ordering.saved-filter.share`). */
  readonly canShare: boolean;
}

/** What a refused save, rename, delete or reorder says (one message per cause). */
export function problemOf(failure: ApiFailure): SavedViewProblem {
  if (failure.code === 'saved-filter.name-taken') return 'name-taken';
  if (failure.code === 'saved-filter.limit-reached') return 'limit';
  if (failure.code === 'saved-filter.shared-limit-reached') return 'shared-limit';
  if (failure.status === 401 || failure.status === 403) return 'denied';
  if (failure.code === 'validation.failed') {
    return failure.details?.fields?.some((field) => field.path === 'name')
      ? 'name-empty'
      : 'unavailable';
  }
  return 'unavailable';
}

/**
 * The saved filters of one list: null until they load, and when the route cannot answer (no
 * permission, an error, an answer that is not a list); the list then has its built-in tabs only.
 * `reload` reads them again and gives back what it read (null when it could not).
 */
export function useSavedFilters<P>(listKey: string): {
  readonly saved: SavedFiltersAnswer<P> | null;
  readonly reload: () => Promise<readonly SavedFilter<P>[] | null>;
} {
  const [saved, setSaved] = useState<SavedFiltersAnswer<P> | null>(null);
  const reload = useCallback(async () => {
    const result = await callApi<SavedFiltersAnswer<P>>(
      'GET',
      `lists/admin/saved-filters?listKey=${listKey}`,
    );
    if (!result.ok || !Array.isArray(result.body?.items)) {
      // A first read that fails hides the controls; a later one keeps what is on show.
      return null;
    }
    const items: readonly SavedFilter<P>[] = result.body.items;
    setSaved({ items, canShare: result.body.canShare === true });
    return items;
  }, [listKey]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { saved, reload };
}

/** A payload's `filters` as the plain object a list's `filtersOf` reads (strings only). */
export function stringsOf(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
