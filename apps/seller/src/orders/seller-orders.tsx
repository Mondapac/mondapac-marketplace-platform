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
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { resolveZone } from '../price/zone-time.ts';
import { numberFormat } from '../shared/intl.ts';
import { OrdersBoard } from './orders-board.tsx';
import { OrdersBulk, SLIPS_MAX } from './orders-bulk.tsx';
import { DEFAULT_COLUMNS, cleanColumns, type OrderColumn } from './orders-columns.ts';
import { OrdersColumnsPanel, OrdersFilterPanel, OrdersSortPanel } from './orders-panels.tsx';
import {
  DEFAULT_QUERY,
  MAX_PAGED_ROWS,
  PAGE_SIZE,
  daysLabel,
  filterCount,
  queryString,
  rangeIsBackwards,
  routeSearch,
  type Direction,
  type ListPaging,
  type Query,
  type SortField,
} from './orders-query.ts';
import { useOrderRowActions } from './orders-row-actions.tsx';
import { OrdersSavedViews } from './orders-saved-views.tsx';
import { LIST_KEY, queryOf, type SavedFilter, type SavedFiltersAnswer } from './orders-saved.ts';
import { OrdersTable } from './orders-table.tsx';
import { SelectionBar } from './selection-bar.tsx';
import {
  FULFILMENT_FILTERS,
  type FulfilmentFilter,
  type SellerOrderCounts,
  type SellerOrderPage,
} from './types.ts';

export type OrdersView = 'table' | 'board';

/** Rows that can be ticked one by one: the most packing slips one print takes. "Select all matching" has no such limit. */
const SELECTION_MAX = SLIPS_MAX;
const OPEN_ENDED = Number.MAX_SAFE_INTEGER;
/** The API's order id search: nothing shorter than a whole id finds an order. */
const SEARCH_MAX = 64;

type Failure = 'refused' | 'unavailable';

function failureOf(code: string): Failure {
  // The API refused the query itself: asking again can never work.
  return code === 'validation.failed' || code === 'ordering.too-deep' ? 'refused' : 'unavailable';
}

const noActions = () => [];

// The query rules of the kit hook, kept at module level so they stay the same between renders.
const forView = (view: string): Query => ({ ...DEFAULT_QUERY, tab: view as FulfilmentFilter });
const withView = (current: Query, view: string): Query => ({
  ...current,
  tab: view as FulfilmentFilter,
});
const searchOf = (current: Query): string => current.q;
// Text that is not an order id asks for nothing: the query keeps the search it had.
const withSearch = (current: Query, text: string): Query =>
  routeSearch(text).kind === 'not-an-id' ? current : { ...current, q: text.trim() };

function countOf(counts: SellerOrderCounts, tab: FulfilmentFilter): number {
  switch (tab) {
    case 'all':
      return counts.toShip + counts.shipped + counts.delivered;
    case 'to-ship':
      return counts.toShip;
    case 'shipped':
      return counts.shipped;
    case 'delivered':
      return counts.delivered;
  }
}

/**
 * The seller's paid orders (a super list): a tab for each fulfilment state and for each saved
 * filter, a search by order id, the filter, sort and column panels with their chips, then one page
 * of orders with a row Actions menu. It follows the Market's List paging setting: page numbers with
 * a total, or Previous and next. The tabs are the API's `status`, so each lists every order in that
 * state. The board view (an overview by stage) stays one click away. The column choice is the
 * seller's own and lives in this browser's storage; a saved filter keeps its tab, days and sort on
 * the server. Rows can be selected, for Print packing slips.
 */
export function SellerOrders({
  initial,
  paging = 'prev-next',
  accountId = '',
  marketId = '',
  csrfToken = '',
  initialView = 'table',
}: {
  readonly initial: SellerOrderPage;
  readonly paging?: ListPaging;
  readonly accountId?: string;
  readonly marketId?: string;
  readonly csrfToken?: string;
  readonly initialView?: OrdersView;
}) {
  const t = useTranslations('orders');
  const ts = useTranslations('orders.list');
  const tl = useTranslations('load');
  const daysWords = {
    range: (from: string, to: string) => t('days.range', { from, to }),
    from: (day: string) => t('days.from', { day }),
    until: (day: string) => t('days.until', { day }),
  };
  const locale = useLocale();
  // The seller's own working zone (UTC when it could not be read): the table's times and the
  // days of the date filters are both on this clock (ADR-0005).
  const zone = resolveZone(useTimeZone());
  const [view, setView] = useState<OrdersView>(initialView);
  const {
    query,
    draft,
    setDraft,
    savedId,
    change,
    goToPage,
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
  const [answer, setAnswer] = useState<SellerOrderPage | null>(initial);
  const [liveCounts, setCounts] = useState<SellerOrderCounts | null>(initial.counts ?? null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [hinted, setHinted] = useState(false);
  const [columns, setColumns] = useState<readonly OrderColumn[]>(DEFAULT_COLUMNS);
  // The saved filters: null until they load, and when they cannot (the page then has the
  // fulfilment tabs only).
  const [saved, setSaved] = useState<SavedFiltersAnswer | null>(null);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  const latest = useRef(0);
  const storageKey = prefsKey('seller', marketId, accountId, 'orders-columns');
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);
  const backwards = rangeIsBackwards(query.days) && query.filters.paid === undefined;

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  const loadSaved = useCallback(async (): Promise<readonly SavedFilter[] | null> => {
    const result = await callApi<SavedFiltersAnswer>(
      'GET',
      `ordering/seller/saved-filters?listKey=${LIST_KEY}`,
    );
    if (!result.ok || !Array.isArray(result.body?.items)) return null;
    setSaved(result.body);
    const items: readonly SavedFilter[] = result.body.items;
    return items;
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  // A saved tab that was deleted is no longer the one on show.
  useEffect(() => {
    if (savedId !== null && saved !== null && !saved.items.some((item) => item.id === savedId)) {
      forgetSaved();
    }
  }, [saved, savedId, forgetSaved]);

  // The date presets are read at each load (and each Try again), on the clock of the seller's
  // zone, so a tab left open past midnight does not keep asking for yesterday's "Today".
  const load = useCallback(
    async (asked: Query) => {
      if (rangeIsBackwards(asked.days) && asked.filters.paid === undefined) {
        // An answer still on its way for the days as they were must not fill the list.
        latest.current += 1;
        setAnswer(null);
        setLoading(false);
        setFailure(null);
        return;
      }
      const request = queryString(asked, { paging, zone, now: new Date() });
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<SellerOrderPage>('GET', `ordering/seller/orders?${request}`);
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        const { status, code } = result.failure;
        if (status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setFailure(failureOf(code));
        return;
      }
      setAnswer(result.body);
      if (result.body.counts !== undefined) setCounts(result.body.counts);
    },
    [paging, zone],
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
  const listKey = JSON.stringify([
    query.tab,
    query.q,
    query.filters,
    query.days,
    query.sort,
    query.direction,
  ]);
  const rows = answer?.sellerOrders;
  const pageIds = useMemo(() => rows?.map((row) => row.sellerOrderId) ?? [], [rows]);
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
  const mode: ListPaging =
    answer === null || answer.total === null || answer.total === undefined ? 'prev-next' : paging;
  const page = answer?.page ?? query.page;

  // A page past the end (rows were removed meanwhile) goes back to the last one that has rows.
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.sellerOrders.length > 0) return;
    if (answer.page !== null && answer.page !== undefined && answer.page > 1) {
      const last =
        mode === 'pages'
          ? Math.max(1, Math.ceil((answer.total ?? 0) / (answer.pageSize ?? PAGE_SIZE)))
          : answer.page - 1;
      goToPage(Math.min(last, answer.page - 1));
    }
  }, [answer, loading, failure, mode, goToPage]);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  // A saved filter is a tab of its own: it does not narrow the counts of the built-in tabs.
  const counts = useBaseTabCounts<SellerOrderCounts>({
    savedId,
    live: liveCounts,
    load: async () => {
      const request = queryString(DEFAULT_QUERY, { paging, zone, now: new Date() });
      const result = await callApi<SellerOrderPage>('GET', `ordering/seller/orders?${request}`);
      return result.ok ? (result.body.counts ?? null) : null;
    },
  });
  const draftRoute = routeSearch(draft);
  // The hint about the typed text waits for the box to lose focus or Enter, so it is not read out
  // at the first keystroke of every search.
  const showHint = hinted && draftRoute.kind === 'not-an-id';

  const refresh = useCallback(() => void load(queryNow.current), [load]);
  const rowActions = useOrderRowActions(csrfToken, refresh);

  const saveColumns = (next: readonly OrderColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => reset({ q: '', filters: {}, days: null });
  const tabLabel = (id: FulfilmentFilter) =>
    t(id === 'all' || id === 'to-ship' ? `filter.${id}` : `status.${id}`);

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
    ...(query.filters.paid === undefined
      ? query.days === null
        ? []
        : [
            {
              key: 'days',
              label: ts('chip', { field: t('col.paid'), value: daysLabel(query.days, daysWords) }),
              onRemove: () => change({ days: null }),
            },
          ]
      : [
          {
            key: 'paid',
            label: ts('chip', {
              field: t('col.paid'),
              value: ts(`date-preset.${query.filters.paid}`),
            }),
            onRemove: () => change({ filters: {} }),
          },
        ]),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;

  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;
  const summary = [
    tabLabel(query.tab),
    ...chips.filter((c) => c.key !== 'search').map((c) => c.label),
  ].join(' · ');

  const shopEmpty =
    answer !== null &&
    failure === null &&
    !filtered &&
    query.tab === 'all' &&
    answer.sellerOrders.length === 0 &&
    (counts === null || countOf(counts, 'all') === 0);
  const empty = shopEmpty ? (
    <EmptyState icon="clipboard" title={t('empty-state.title')} body={t('empty-state.body')} />
  ) : (
    <EmptyState
      size="compact"
      icon={filtered || backwards ? 'search' : 'clipboard'}
      title={filtered || backwards ? ts('empty-filtered.title') : t('filter.empty.title')}
      body={filtered || backwards ? ts('empty-filtered.body') : t('filter.empty.body')}
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
  const shown = answer?.sellerOrders ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.sellerOrderId));
  const moreThanPage =
    mode === 'pages' ? (answer?.total ?? 0) > shown.length : answer?.hasNext === true || page > 1;
  const start = (page - 1) * PAGE_SIZE;
  const sortOrder = ts(
    `sort.${query.sort === 'total' ? 'amount' : 'date'}.${query.direction === 'desc' ? 'first' : 'second'}`,
  );

  function pick(next: OrdersView) {
    setView(next);
    // The view stays in the address, so a reload or a shared link opens the same one.
    const url = new URL(window.location.href);
    if (next === 'board') url.searchParams.set('view', 'board');
    else url.searchParams.delete('view');
    window.history.replaceState(null, '', url);
  }

  const toggle = (
    <div role="group" aria-label={t('board.view')} className="flex gap-2">
      {(['table', 'board'] as const).map((id) => (
        <Button
          key={id}
          variant={view === id ? 'primary' : 'secondary'}
          aria-pressed={view === id}
          onClick={() => pick(id)}
        >
          {t(`board.${id}`)}
        </Button>
      ))}
    </div>
  );

  if (view === 'board') {
    return (
      <div className="flex flex-col gap-4">
        {toggle}
        <OrdersBoard />
      </div>
    );
  }

  const table = (
    <div className="flex flex-col gap-4">
      {mode === 'pages' && (answer?.total ?? 0) > MAX_PAGED_ROWS ? (
        <p role="status" className="rounded-lg border border-line bg-muted px-4 py-2 text-sm">
          {t('too-many', { limit: number(MAX_PAGED_ROWS) })}
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
        <OrdersTable
          rows={shown}
          columns={columns}
          empty={empty}
          skeletonRows={skeleton ? listSkeletonRowCount(PAGE_SIZE) : undefined}
          // Rows kept after a failed refresh belong to another list than the query: no actions.
          actions={failure === null ? rowActions.items : noActions}
          selection={selection}
        />
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {toggle}
      <SuperList
        heading={{
          actions: (
            <OrdersBulk
              exportQuery={() => {
                // The route takes the tab and the paid days only; the relay drops the rest.
                const params = new URLSearchParams(
                  queryString(query, { paging: 'prev-next', zone, now: new Date() }),
                );
                for (const key of ['q', 'page', 'pageSize', 'paging', 'sort', 'direction']) {
                  params.delete(key);
                }
                return params.toString();
              }}
              columns={columns}
              zone={zone}
              searching={routeSearch(query.q).kind === 'q'}
              empty={answer !== null && shown.length === 0}
              selection={{
                ids: [...selection.selected],
                allMatching: selection.allMatching,
                total,
              }}
            />
          ),
        }}
        views={{
          label: t('filter.label'),
          activeId: savedId ?? query.tab,
          onSelect: (id) => {
            const filter = saved?.items.find((item) => item.id === id);
            if (filter !== undefined) openSavedTab(id, queryOf(filter.payload));
            else openView(id);
          },
          items: [
            ...FULFILMENT_FILTERS.map((id) => ({
              id,
              label: `${tabLabel(id)}${counts === null ? '' : ` (${number(countOf(counts, id))})`}`,
            })),
            ...(saved?.items ?? []).map((item) => ({ id: item.id, label: item.name })),
          ],
          manage:
            saved === null
              ? null
              : { label: t('saved.manage-link'), onClick: () => setDialog('manage') },
        }}
        search={{
          label: ts('search.label'),
          placeholder: ts('search.placeholder'),
          value: draft,
          maxLength: SEARCH_MAX,
          onChange: (value) => {
            setHinted(false);
            setDraft(value);
          },
          onBlur: () => setHinted(true),
          onSubmit: (value) => {
            setHinted(true);
            if (routeSearch(value).kind === 'not-an-id') return;
            change({ q: value.trim() });
          },
          extra: showHint ? (
            <p role="status" className="w-full text-sm text-fg-muted">
              {ts('search.not-an-id')}
            </p>
          ) : undefined,
        }}
        filter={{
          label: ts('filter.button'),
          count: filterCount(query),
          panel: (close) => (
            <OrdersFilterPanel
              filters={query.filters}
              onApply={(filters) =>
                change({ filters, days: filters.paid === undefined ? query.days : null })
              }
              close={close}
            />
          ),
        }}
        sort={{
          label: ts('sort.button'),
          panel: () => (
            <OrdersSortPanel
              sort={query.sort}
              direction={query.direction}
              onChange={(sort: SortField, direction: Direction) => change({ sort, direction })}
            />
          ),
        }}
        columns={{
          label: ts('columns-button'),
          panel: (close) => (
            <OrdersColumnsPanel columns={columns} onSave={saveColumns} close={close} />
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
                  : { save: { label: t('saved.save-link'), onClick: () => setDialog('save') } }),
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
                  message: t('error.unavailable'),
                  retry: { label: tl('retry'), onClick: () => void load(query) },
                }
        }
        firstLoadError={firstLoadError}
        loading={loading}
        status={status}
        loadingLabel={t('loading')}
        slowLabel={tl('slow')}
        ready={answer !== null || backwards}
        table={table}
        pagination={
          answer !== null && answer.sellerOrders.length > 0 && failure === null
            ? {
                mode,
                page,
                pageSize: PAGE_SIZE,
                // No page size picker in this round: one size.
                pageSizes: [PAGE_SIZE],
                // The footer is never offered a page past row 10,000: a total above it is cut here
                // (the note above the rows says why).
                total:
                  mode === 'pages'
                    ? Math.min(answer.total ?? 0, MAX_PAGED_ROWS)
                    : answer.hasNext === true
                      ? page * PAGE_SIZE + 1
                      : (page - 1) * PAGE_SIZE + answer.sellerOrders.length,
                maxRows: mode === 'pages' ? MAX_PAGED_ROWS : OPEN_ENDED,
                // Previous and next has no total, so no range line.
                range:
                  mode === 'pages' && answer.total !== null && answer.total !== undefined
                    ? t('range', {
                        from: number(start + 1),
                        to: number(start + answer.sellerOrders.length),
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
                onPageSize: () => {},
              }
            : null
        }
        dialogs={
          <>
            {rowActions.dialogs}
            {saved === null ? null : (
              <OrdersSavedViews
                dialog={dialog}
                onClose={() => setDialog(null)}
                query={query}
                zone={zone}
                summary={summary}
                saved={saved}
                csrfToken={csrfToken}
                onSaved={(filter) => {
                  void loadSaved().then((items) => {
                    // Only a filter that is in the reloaded list can be the tab on show.
                    if (items?.some((item) => item.id === filter.id) === true) {
                      openSavedTab(filter.id, queryOf(filter.payload));
                    }
                  });
                }}
                onChanged={() => void loadSaved()}
              />
            )}
          </>
        }
      />
    </div>
  );
}
