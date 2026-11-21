'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../index.ts';
import {
  ManageViewsDialog,
  SaveViewDialog,
  type SavedViewItem,
  type SavedViewLabels,
  type SavedViewProblem,
  type SavedViewVisibility,
} from '../list-views/saved-view-dialogs.tsx';
import type { PagedListConfig, PagedListRuntime, PagedQuery, PagedTranslator } from './types.ts';

// Saved personal and shared filters of a page-numbered super list, through the generic routes of
// the `lists` module (one registry for every list; the payload is the closed document of
// `savedListPayloadParser`). Only the shared kit knows these routes; a list names its key.

/** The limits the server enforces (per owner and shared); the answer names none. */
export const SAVED_LIMITS = { perOwner: 50, shared: 20 } as const;

export interface SavedPayload {
  readonly v: 1;
  readonly view?: string;
  readonly q?: string;
  readonly filters: Readonly<Record<string, string>>;
  readonly sort: string;
  readonly direction: 'asc' | 'desc';
}

export interface SavedFilter {
  readonly id: string;
  readonly listKey: string;
  readonly name: string;
  readonly visibility: SavedViewVisibility;
  readonly payload: SavedPayload;
  readonly ownedByMe: boolean;
  readonly canManage: boolean;
}

export interface SavedFiltersAnswer {
  readonly items: readonly SavedFilter[];
  readonly canShare: boolean;
}

type TabsOf<Row> = Pick<PagedListConfig<Row>, 'tabs' | 'tabParam' | 'tabParams' | 'savedViews'>;

/** The query parameters a built-in tab sets (the route's payload has no views). */
export function tabFilters<Row>(config: TabsOf<Row>, tab: string): Record<string, string> {
  const own = Object.entries(config.tabParams?.(tab) ?? {}).filter(
    // A tab that sets no value for a parameter (a list's "all") leaves it out.
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return {
    ...Object.fromEntries(own),
    ...(tab !== config.tabs[0] && config.tabParam !== undefined ? { [config.tabParam]: tab } : {}),
  };
}

/** What a list holds now, as the document a saved filter keeps (paging and columns are not kept). */
export function payloadOf<Row>(config: TabsOf<Row>, query: PagedQuery): SavedPayload {
  if (config.savedViews === true) {
    return {
      v: 1,
      view: query.tab,
      ...(query.q === '' ? {} : { q: query.q }),
      filters: query.filters,
      sort: query.sort,
      direction: query.direction,
    };
  }
  return {
    v: 1,
    ...(query.q === '' ? {} : { q: query.q }),
    filters: { ...query.filters, ...tabFilters(config, query.tab) },
    sort: query.sort,
    direction: query.direction,
  };
}

/** The query a saved document opens: the built-in tab its parameters name, then the rest as filters. */
export function queryOfPayload<Row>(
  config: TabsOf<Row>,
  defaults: PagedQuery,
  payload: SavedPayload,
): PagedQuery {
  if (config.savedViews === true) {
    const view =
      payload.view !== undefined && config.tabs.includes(payload.view)
        ? payload.view
        : defaults.tab;
    return {
      ...defaults,
      tab: view,
      q: payload.q ?? '',
      filters: payload.filters,
      sort: payload.sort,
      direction: payload.direction,
      page: 1,
    };
  }
  let best = config.tabs[0] ?? defaults.tab;
  let bestMatches = 0;
  let consumed: readonly string[] = [];
  for (const tab of config.tabs) {
    const own = Object.entries(tabFilters(config, tab));
    if (own.length === 0 || !own.every(([name, value]) => payload.filters[name] === value))
      continue;
    if (own.length > bestMatches) {
      best = tab;
      bestMatches = own.length;
      consumed = own.map(([name]) => name);
    }
  }
  // Parameters every tab carries with one value (a queue's fixed `kind`) belong to no tab: they are
  // not filters.
  const perTab = config.tabs.map((tab) => tabFilters(config, tab));
  const constant = Object.keys(perTab[0] ?? {}).filter((name) =>
    perTab.every((own) => own[name] === perTab[0]?.[name]),
  );
  const dropped = new Set([...consumed, ...constant]);
  const filters = Object.fromEntries(
    Object.entries(payload.filters).filter(([name]) => !dropped.has(name)),
  );
  return {
    ...defaults,
    tab: best,
    q: payload.q ?? '',
    filters,
    sort: payload.sort,
    direction: payload.direction,
    page: 1,
  };
}

/** A saved filter that fits the list (several lists can share one key). */
export const fits = <Row,>(config: PagedListConfig<Row>, filter: SavedFilter): boolean =>
  config.savedFits === undefined || config.savedFits(filter.payload.filters, filter.payload);

/**
 * The ids of the person's own filters in their new order, as the order route wants them: all of
 * them. Lists that share one key show only their own, so the others keep their places.
 */
export function wholeOrder(
  all: readonly SavedFilter[],
  shown: readonly SavedFilter[],
  ids: readonly string[],
): string[] {
  const fitting = new Set(shown.map((item) => item.id));
  const queue = [...ids];
  return all
    .filter((item) => item.ownedByMe)
    .map((item) => (fitting.has(item.id) ? (queue.shift() ?? item.id) : item.id));
}

/** What a refused save, rename, delete or reorder says (one message per cause). */
export function problemOf(failure: {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
}): SavedViewProblem {
  if (failure.code === 'saved-filter.name-taken') return 'name-taken';
  if (failure.code === 'saved-filter.limit-reached') return 'limit';
  if (failure.code === 'saved-filter.shared-limit-reached') return 'shared-limit';
  if (failure.status === 401 || failure.status === 403) return 'denied';
  if (failure.code === 'validation.failed') {
    const fields = (failure.details as { fields?: readonly { path: string }[] } | undefined)
      ?.fields;
    return fields?.some((field) => field.path === 'name') === true ? 'name-empty' : 'unavailable';
  }
  return 'unavailable';
}

/**
 * The saved filters of one list: null until they load, and when the route cannot answer (no
 * permission, an error); the list then has its built-in tabs only. `reload` reads them again and
 * gives back what it read (null when it could not).
 */
export function usePagedSavedFilters(
  runtime: PagedListRuntime,
  listKey: string | undefined,
  enabled: boolean,
): {
  readonly saved: SavedFiltersAnswer | null;
  readonly reload: () => Promise<readonly SavedFilter[] | null>;
} {
  const path = runtime.savedFiltersPath;
  const { callApi } = runtime;
  const [saved, setSaved] = useState<SavedFiltersAnswer | null>(null);
  // Only the newest read counts: an older answer landing late never overwrites a newer one.
  const latest = useRef(0);
  const reload = useCallback(async () => {
    if (!enabled || listKey === undefined || path === undefined) return null;
    const ticket = ++latest.current;
    const result = await callApi<SavedFiltersAnswer>(
      'GET',
      `${path}?listKey=${encodeURIComponent(listKey)}`,
    );
    if (ticket !== latest.current) return null;
    if (!result.ok || !Array.isArray(result.body?.items)) return null;
    const items: readonly SavedFilter[] = result.body.items;
    setSaved({ items, canShare: result.body.canShare === true });
    return items;
  }, [callApi, enabled, listKey, path]);
  useEffect(() => {
    // Another list (or none) has other saved filters: nothing of the last one stays on show.
    setSaved(null);
    void reload();
    return () => {
      latest.current += 1;
    };
  }, [reload]);
  return { saved, reload };
}

function useLabels(ts: PagedTranslator): SavedViewLabels {
  return useMemo(
    () => ({
      cancel: ts('saved.cancel'),
      visibility: { me: ts('saved.visibility.me'), everyone: ts('saved.visibility.everyone') },
      save: {
        title: ts('saved.save.title'),
        submit: ts('saved.save.submit'),
        name: ts('saved.save.name'),
        who: ts('saved.save.who'),
        everyoneHelp: ts('saved.save.everyone-help'),
        ownOnly: ts('saved.save.own-only'),
      },
      manage: {
        title: ts('saved.manage.title'),
        close: ts('saved.manage.close'),
        empty: ts('saved.manage.empty'),
        emptyHelp: ts('saved.manage.empty-help'),
        helpShare: ts('saved.manage.help-share'),
        helpOwn: ts('saved.manage.help-own'),
        sharedByOther: ts('saved.manage.shared-by-other'),
        edit: ts('saved.manage.edit'),
        delete: ts('saved.manage.delete'),
        save: ts('saved.manage.save'),
        deleteConfirm: ts('saved.manage.delete-confirm'),
        editNamed: (name) => ts('saved.manage.edit-named', { name }),
        deleteNamed: (name) => ts('saved.manage.delete-named', { name }),
        deleteOwn: (name) => ts('saved.manage.delete-own', { name }),
        deleteShared: (name) => ts('saved.manage.delete-shared', { name }),
        moveUp: (name) => ts('saved.manage.move-up', { name }),
        moveDown: (name) => ts('saved.manage.move-down', { name }),
      },
      error: (problem) =>
        ts(`saved.error.${problem}`, {
          max: problem === 'shared-limit' ? SAVED_LIMITS.shared : SAVED_LIMITS.perOwner,
        }),
    }),
    [ts],
  );
}

/** The Save filter and Manage filters dialogs of a list, wired to the generic saved-filter routes. */
export function PagedSavedDialogs({
  runtime,
  ts,
  dialog,
  onClose,
  listKey,
  payload,
  summary,
  saved,
  items,
  csrfToken,
  idPrefix,
  onSaved,
  onChanged,
}: {
  readonly runtime: PagedListRuntime;
  /** The shared `sales-lists` translations of the panel (`saved.*`). */
  readonly ts: PagedTranslator;
  readonly dialog: 'save' | 'manage' | null;
  readonly onClose: () => void;
  readonly listKey: string;
  readonly payload: SavedPayload;
  readonly summary: string;
  readonly saved: SavedFiltersAnswer;
  /** The saved filters that fit this list. */
  readonly items: readonly SavedFilter[];
  readonly csrfToken: string;
  readonly idPrefix: string;
  readonly onSaved: (filter: SavedFilter) => void;
  readonly onChanged: () => void;
}) {
  const labels = useLabels(ts);
  const { callApi, savedFiltersPath: path } = runtime;
  if (path === undefined) return null;
  const toastOptions = { id: `${idPrefix}-saved-filter` };
  const views: readonly SavedViewItem[] = items;
  return (
    <>
      <SaveViewDialog
        open={dialog === 'save'}
        onClose={onClose}
        summary={summary}
        canShare={saved.canShare}
        labels={labels}
        idPrefix={idPrefix}
        onSave={async (name, visibility) => {
          const result = await callApi<SavedFilter>(
            'POST',
            path,
            { listKey, name, visibility, payload },
            csrfToken,
          );
          if (!result.ok) return problemOf(result.failure);
          toast.success(ts('saved.toast.saved', { name: result.body.name }), toastOptions);
          onSaved(result.body);
          return null;
        }}
      />
      <ManageViewsDialog
        open={dialog === 'manage'}
        onClose={onClose}
        views={views}
        canShare={saved.canShare}
        labels={labels}
        idPrefix={idPrefix}
        onRename={async (id, name, visibility) => {
          const result = await callApi<SavedFilter>(
            'PUT',
            `${path}/${encodeURIComponent(id)}`,
            { listKey, name, visibility },
            csrfToken,
          );
          if (!result.ok) return problemOf(result.failure);
          toast.success(ts('saved.toast.updated', { name: result.body.name }), toastOptions);
          onChanged();
          return null;
        }}
        onDelete={async (id) => {
          const name = items.find((item) => item.id === id)?.name ?? '';
          const result = await callApi<{ id: string }>(
            'DELETE',
            `${path}/${encodeURIComponent(id)}?listKey=${encodeURIComponent(listKey)}`,
            undefined,
            csrfToken,
          );
          // A filter already gone is what the person wanted: say so and refresh the list.
          if (!result.ok && result.failure.code !== 'saved-filter.not-found') {
            return problemOf(result.failure);
          }
          toast.success(ts('saved.toast.deleted', { name }), toastOptions);
          onChanged();
          return null;
        }}
        onReorder={async (ids, movedId) => {
          const whole = wholeOrder(saved.items, items, ids);
          const result = await callApi<{ ids: readonly string[] }>(
            'PUT',
            `${path}/order`,
            { listKey, ids: whole },
            csrfToken,
          );
          if (!result.ok) {
            // A refused order may mean the filters changed meanwhile: reload them under the banner.
            onChanged();
            return problemOf(result.failure);
          }
          toast.success(
            ts('saved.toast.moved', {
              name: items.find((item) => item.id === movedId)?.name ?? '',
            }),
            toastOptions,
          );
          onChanged();
          return null;
        }}
      />
    </>
  );
}
