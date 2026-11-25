'use client';

import {
  Button,
  EmptyState,
  SuperList,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  useBaseTabCounts,
  useListLoading,
  useRowSelection,
  useSuperListQuery,
  writeIds,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { AddOfferButton } from './add-offer-button.tsx';
import { OffersBulk } from './offers-bulk.tsx';
import { DEFAULT_COLUMNS, cleanColumns, type OfferColumn } from './offers-columns.ts';
import { OffersColumnsPanel, OffersFilterPanel, OffersSortPanel } from './offers-panels.tsx';
import {
  DEFAULT_QUERY,
  MAX_PAGED_ROWS,
  PAGE_SIZES,
  defaultDirection,
  SEARCH_MAX,
  SELECTION_MAX,
  VIEWS,
  filterCount,
  queryString,
  type Direction,
  type ListPaging,
  type Query,
  type SortField,
  type View,
} from './offers-query.ts';
import { useOfferRowActions } from './offers-row-actions.tsx';
import { OffersSavedViews } from './offers-saved-views.tsx';
import { LIST_KEY, queryOf, type SavedFilter, type SavedFiltersAnswer } from './offers-saved.ts';
import { OffersTable } from './offers-table.tsx';
import { EDIT_PERMISSION, type OfferListCounts, type OfferListPage } from './types.ts';

const OPEN_ENDED = Number.MAX_SAFE_INTEGER;

type Failure = 'refused' | 'unavailable';

function failureOf(status: number, code: string): Failure {
  // The API refused the query itself (a page past row 10,000, a closed value): asking again
  // can never work.
  return status === 400 && code === 'validation.failed' ? 'refused' : 'unavailable';
}

const noActions = () => [];

// The query rules of the kit hook, kept at module level so they stay the same between renders.
const forView = (view: string): Query => ({ ...DEFAULT_QUERY, tab: view as View });
const withView = (current: Query, view: string): Query => ({ ...current, tab: view as View });
const searchOf = (current: Query): string => current.q;
const withSearch = (current: Query, text: string): Query => ({ ...current, q: text.trim() });

function countOf(counts: OfferListCounts, tab: View): number {
  switch (tab) {
    case 'all':
      return counts.all;
    case 'drafts':
      return counts.draft;
    case 'in-review':
      return counts.pendingFirstPublish;
    case 'changes-needed':
      return counts.changesNeeded;
    case 'live':
      return counts.published;
  }
}

/**
 * The seller's Offers (a super list): a tab for each stage with its count, a search (SKU, product
 * code or product name), the filter, sort and column panels with their chips, then one page of
 * Offers with a row Actions menu. It follows the Market's List paging setting: page numbers with a
 * total, or Previous and next. Rows can be selected, for Export. The column choice is the seller's
 * own and lives in this browser's storage. A saved filter keeps the tab, search, filters and sort
 * on the server and is its own tab.
 */
export function OffersList({
  initial,
  paging,
  accountId,
  marketId,
  csrfToken,
  permissionKeys,
  timeZone,
}: {
  readonly initial: OfferListPage;
  readonly paging: ListPaging;
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken: string;
  readonly permissionKeys: readonly string[];
  /** The seller's own zone, or null when none was chosen. */
  readonly timeZone: string | null;
}) {
  const t = useTranslations('catalog.offers');
  const ts = useTranslations('catalog.offers.list');
  const tl = useTranslations('load');
  const locale = useLocale();
  const {
    query,
    draft,
    setDraft,
    savedId,
    change,
    goToPage,
    paginate,
    openView,
    openSaved: openSavedTab,
    forgetSaved,
    reset,
  } = useSuperListQuery<Query>({
    defaultQuery: DEFAULT_QUERY,
    forView,
    withView,
    searchOf,
    withSearch,
  });

  // The page the server read opens the list: no first request for the same query.
  const [answer, setAnswer] = useState<OfferListPage | null>(initial);
  const [liveCounts, setCounts] = useState<OfferListCounts | null>(initial.counts);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [columns, setColumns] = useState<readonly OfferColumn[]>(DEFAULT_COLUMNS);
  // The saved filters: null until they load, and when they cannot (the page then has the stage
  // tabs only).
  const [saved, setSaved] = useState<SavedFiltersAnswer | null>(null);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  const latest = useRef(0);
  const storageKey = prefsKey('seller', marketId, accountId, 'offers-columns');
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  const loadSaved = useCallback(async (): Promise<readonly SavedFilter[] | null> => {
    const result = await callApi<SavedFiltersAnswer>(
      'GET',
      `catalog/seller/saved-filters?listKey=${LIST_KEY}`,
    );
    if (!result.ok || !Array.isArray(result.body?.items)) return null;
    setSaved(result.body);
    const items: readonly SavedFilter[] = result.body.items;
    return items;
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  // A saved tab that was deleted (here or by its owner) is no longer the one on show.
  useEffect(() => {
    if (savedId !== null && saved !== null && !saved.items.some((item) => item.id === savedId)) {
      forgetSaved();
    }
  }, [saved, savedId, forgetSaved]);

  const load = useCallback(
    async (asked: Query) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<OfferListPage>(
        'GET',
        `catalog/seller/offers?${queryString(asked, paging)}`,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        const { status, code } = result.failure;
        if (status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setFailure(failureOf(status, code));
        return;
      }
      setAnswer(result.body);
      setCounts(result.body.counts);
    },
    [paging],
  );

  // A query that is equal in content is not a new list: load again only when it changed. The
  // first query is the one the server already answered.
  const queryNow = useRef(query);
  queryNow.current = query;
  const queryKey = JSON.stringify(query);
  const firstKey = useRef(queryKey);
  const served = useRef(true);
  useEffect(() => {
    if (served.current && queryKey === firstKey.current) {
      served.current = false;
      return;
    }
    served.current = false;
    void load(queryNow.current);
  }, [load, queryKey]);

  // A new tab, search, filter or sort is another list: the selection does not follow it. Paging
  // keeps it, so rows can be ticked on several pages.
  const listKey = JSON.stringify([query.tab, query.q, query.filters, query.sort, query.direction]);
  const rows = answer?.items;
  const pageIds = useMemo(() => rows?.map((row) => row.offerId) ?? [], [rows]);
  const selection = useRowSelection(pageIds, SELECTION_MAX, listKey);
  // Panel loading L2: skeleton rows on the first load, dimmed rows on a later one.
  const status = useListLoading(loading, answer !== null);
  // A first load that runs past 30 s gives up: its answer is dropped and Try again starts anew.
  useEffect(() => {
    if (!status.stalled) return;
    latest.current += 1;
    setLoading(false);
    setFailure('unavailable');
  }, [status.stalled]);

  useEffect(() => {
    if (!loading && focusList.current) {
      focusList.current = false;
      listTop.current?.focus();
    }
  }, [loading, answer]);

  // The API answers with a total only for page numbers: its answer, not the setting, says which
  // footer fits the rows on show.
  const mode: ListPaging = answer === null || answer.total === null ? 'prev-next' : paging;
  const page = answer?.page ?? query.page;
  const pageSize = answer?.pageSize ?? query.pageSize;

  // A page past the end (rows were removed meanwhile) goes back to the last one that has rows.
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.items.length > 0) return;
    if (answer.page > 1) {
      const last =
        mode === 'pages'
          ? Math.max(1, Math.ceil((answer.total ?? 0) / answer.pageSize))
          : answer.page - 1;
      goToPage(Math.min(last, answer.page - 1));
    }
  }, [answer, loading, failure, mode, goToPage]);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  // A saved filter is a tab of its own: it does not narrow the counts of the built-in tabs.
  const counts = useBaseTabCounts<OfferListCounts>({
    savedId,
    live: liveCounts,
    load: async () => {
      const result = await callApi<OfferListPage>(
        'GET',
        `catalog/seller/offers?${queryString({ ...DEFAULT_QUERY, pageSize: 1 }, paging)}`,
      );
      return result.ok ? result.body.counts : null;
    },
  });
  const refresh = useCallback(() => void load(queryNow.current), [load]);
  const rowActions = useOfferRowActions(csrfToken, permissionKeys, () => {
    // A deleted or submitted offer must not stay ticked: an export of it would be refused.
    selection.clear();
    refresh();
  });

  const saveColumns = (next: readonly OfferColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => reset({ q: '', filters: {} });
  const withoutFilter = (field: keyof Query['filters']): Query['filters'] =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const chips = [
    ...(query.q === ''
      ? []
      : [
          {
            key: 'search',
            label: ts('chip-search', { text: query.q }),
            onRemove: () => reset({ q: '' }),
          },
        ]),
    ...(query.filters.status === undefined
      ? []
      : [
          {
            key: 'status',
            label: ts('chip', {
              field: t('col.status'),
              value: t(`status.${query.filters.status}`),
            }),
            onRemove: () => change({ filters: withoutFilter('status') }),
          },
        ]),
    ...(query.filters.listed === undefined
      ? []
      : [
          {
            key: 'listed',
            label: ts('chip', {
              field: t('col.listed'),
              value: t(query.filters.listed === 'true' ? 'listed.yes' : 'listed.no'),
            }),
            onRemove: () => change({ filters: withoutFilter('listed') }),
          },
        ]),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;
  const summary = [
    ts(`tab.${query.tab}`),
    ...chips.filter((chip) => chip.key !== 'search').map((chip) => chip.label),
  ].join(' · ');

  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;
  const shown = answer?.items ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.offerId));
  const moreThanPage =
    mode === 'pages' ? (answer?.total ?? 0) > shown.length : answer?.hasNext === true || page > 1;
  const start = (page - 1) * pageSize;
  const sortOrder = ts(
    `sort.${query.sort === 'created' ? 'date' : 'text'}.${query.direction === defaultDirection(query.sort) ? 'first' : 'second'}`,
  );

  const shopEmpty =
    answer !== null &&
    failure === null &&
    !filtered &&
    query.tab === 'all' &&
    answer.items.length === 0 &&
    (counts === null || counts.all === 0);
  const empty = shopEmpty ? (
    <EmptyState icon="tag" title={t('empty.title')} body={t('empty.body')} />
  ) : (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'tag'}
      title={filtered ? ts('empty-filtered.title') : ts(`empty.${query.tab}.title`)}
      body={filtered ? ts('empty-filtered.body') : ts(`empty.${query.tab}.body`)}
      action={
        filtered ? (
          <Button variant="secondary" onClick={clearAll}>
            {ts('clear-all')}
          </Button>
        ) : undefined
      }
    />
  );

  const skeleton = status.skeleton && failure === null;
  const firstLoadError = answer === null && failure === 'unavailable';

  const table = (
    <div className="flex flex-col gap-4">
      {mode === 'pages' && (answer?.total ?? 0) > MAX_PAGED_ROWS ? (
        <p role="status" className="rounded-lg border border-line bg-muted px-4 py-2 text-sm">
          {ts('too-many', { limit: number(MAX_PAGED_ROWS) })}
        </p>
      ) : null}
      <SelectionBar
        active={selection.selected.size > 0 || selection.allMatching}
        allMatching={selection.allMatching}
        canSelectAll={wholePageTicked && moreThanPage && failure === null}
        labels={{
          selected: ts('selection.selected', { count: selection.selected.size }),
          all: total === null ? ts('selection.all-open') : ts('selection.all', { count: total }),
          selectAll:
            total === null
              ? ts('selection.select-all-open')
              : ts('selection.select-all', { count: total }),
          clear: ts('selection.clear'),
        }}
        onSelectAll={selection.selectAllMatching}
        onClear={selection.clear}
      />
      <div ref={listTop} tabIndex={-1} className="outline-none">
        <OffersTable
          rows={shown}
          columns={columns}
          empty={empty}
          skeletonRows={skeleton ? listSkeletonRowCount(pageSize) : undefined}
          // Rows kept after a failed refresh belong to another list than the query: no actions.
          actions={failure === null ? rowActions.items : noActions}
          selection={selection}
        />
      </div>
    </div>
  );

  return (
    <SuperList
      heading={{
        actions: (
          <>
            {permissionKeys.includes(EDIT_PERMISSION) ? (
              <AddOfferButton csrfToken={csrfToken} />
            ) : null}
            <OffersBulk
              selection={{
                ids: [...selection.selected],
                allMatching: selection.allMatching,
                total,
              }}
              query={query}
              columns={columns}
              total={total}
              timeZone={timeZone}
            />
          </>
        ),
      }}
      views={{
        label: ts('tabs'),
        activeId: savedId ?? query.tab,
        onSelect: (id) => {
          const filter = saved?.items.find((item) => item.id === id);
          if (filter !== undefined) openSavedTab(id, queryOf(filter.payload, query.pageSize));
          else openView(id);
        },
        items: [
          ...VIEWS.map((id) => ({
            id,
            label: `${ts(`tab.${id}`)}${counts === null ? '' : ` (${number(countOf(counts, id))})`}`,
          })),
          ...(saved?.items ?? []).map((item) => ({ id: item.id, label: item.name })),
        ],
        manage:
          saved === null
            ? null
            : { label: ts('saved.manage-link'), onClick: () => setDialog('manage') },
      }}
      search={{
        label: ts('search.label'),
        placeholder: ts('search.placeholder'),
        value: draft,
        maxLength: SEARCH_MAX,
        onChange: setDraft,
        onSubmit: (value) => change({ q: value.trim() }),
      }}
      filter={{
        label: ts('filter.button'),
        count: filterCount(query),
        panel: (close) => (
          <OffersFilterPanel
            filters={query.filters}
            onApply={(filters) => change({ filters })}
            close={close}
          />
        ),
      }}
      sort={{
        label: ts('sort.button'),
        panel: () => (
          <OffersSortPanel
            sort={query.sort}
            direction={query.direction}
            onChange={(sort: SortField, direction: Direction) => change({ sort, direction })}
          />
        ),
      }}
      columns={{
        label: ts('columns-button'),
        panel: (close) => (
          <OffersColumnsPanel columns={columns} onSave={saveColumns} close={close} />
        ),
      }}
      sortedLine={ts('sorted', { field: ts(`sort.field.${query.sort}`), order: sortOrder })}
      chips={
        filtered
          ? {
              chips,
              clearAll: { label: ts('clear-all'), onClick: clearAll },
              ...(saved === null || savedId !== null
                ? {}
                : { save: { label: ts('saved.save-link'), onClick: () => setDialog('save') } }),
              status: total === null || failure !== null ? '' : ts('match', { count: total }),
            }
          : null
      }
      failure={
        failure === null
          ? null
          : failure === 'refused'
            ? // Asking again cannot work: no Try again, the words say what to change.
              { message: ts('error.refused') }
            : {
                message: ts('error.unavailable'),
                retry: { label: tl('retry'), onClick: () => void load(query) },
              }
      }
      firstLoadError={firstLoadError}
      loading={loading}
      status={status}
      loadingLabel={ts('loading')}
      slowLabel={tl('slow')}
      ready={answer !== null}
      table={table}
      pagination={
        answer !== null && answer.items.length > 0 && failure === null
          ? {
              mode,
              page,
              pageSize,
              pageSizes: PAGE_SIZES,
              // The footer is never offered a page past row 10,000: a total above it is cut here
              // (the note above the rows says why).
              total:
                mode === 'pages'
                  ? Math.min(answer.total ?? 0, MAX_PAGED_ROWS)
                  : answer.hasNext
                    ? page * pageSize + 1
                    : (page - 1) * pageSize + answer.items.length,
              maxRows: mode === 'pages' ? MAX_PAGED_ROWS : OPEN_ENDED,
              // Previous and next has no total, so no range line.
              range:
                mode === 'pages' && answer.total !== null
                  ? ts('range', {
                      from: number(start + 1),
                      to: number(start + answer.items.length),
                      total: number(answer.total),
                    })
                  : '',
              labels: {
                rowsPerPage: ts('paging.rows-per-page'),
                previous: ts('paging.previous'),
                next: ts('paging.next'),
                pages: ts('paging.pages'),
                page: (n) => ts('paging.page', { page: n }),
                narrowTitle: ts('paging.narrow'),
                narrowBody: ts('paging.narrow-help'),
              },
              disabled: loading,
              onPage: (target) => {
                focusList.current = true;
                goToPage(target);
              },
              onPageSize: (size) => paginate({ pageSize: size }),
            }
          : null
      }
      dialogs={
        <>
          {rowActions.dialogs}
          {saved === null ? null : (
            <OffersSavedViews
              dialog={dialog}
              onClose={() => setDialog(null)}
              query={query}
              summary={summary}
              saved={saved}
              csrfToken={csrfToken}
              onSaved={(filter) => {
                void loadSaved().then((items) => {
                  // Only a filter that is in the reloaded list can be the tab on show.
                  if (items?.some((item) => item.id === filter.id) === true) {
                    openSavedTab(filter.id, queryOf(filter.payload, query.pageSize));
                  }
                });
              }}
              onChanged={() => void loadSaved()}
            />
          )}
        </>
      }
    />
  );
}

/** The bar over the list while rows are selected: how many, "Select all N matching", and Clear. */
function SelectionBar({
  active,
  allMatching,
  canSelectAll,
  labels,
  onSelectAll,
  onClear,
}: {
  readonly active: boolean;
  readonly allMatching: boolean;
  readonly canSelectAll: boolean;
  readonly labels: {
    readonly selected: string;
    readonly all: string;
    readonly selectAll: string;
    readonly clear: string;
  };
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
