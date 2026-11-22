'use client';

import {
  Button,
  EmptyState,
  SuperList,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  useListLoading,
  useRowSelection,
  useBaseTabCounts,
  useSuperListQuery,
  writeIds,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { SelectionBar } from '../sales/selection-bar.tsx';
import { SEARCH_MAX, routeSearch } from '../sales/search-route.ts';
import { numberFormat } from '../shared/intl.ts';
import { OrdersBulk } from './orders-bulk.tsx';
import { DEFAULT_COLUMNS, cleanColumns, type OrderColumn } from './orders-columns.ts';
import { OrdersColumnsPanel } from './orders-columns-panel.tsx';
import { OrdersFilterPanel } from './orders-filter-panel.tsx';
import {
  DEFAULT_QUERY,
  MAX_PAGED_ROWS,
  PAGE_SIZE,
  daysLabel,
  filterCount,
  queryString,
  rangeIsBackwards,
  type Direction,
  type ListPaging,
  type Query,
  type SortField,
} from './orders-query.ts';
import { useOrderRowActions } from './orders-row-actions.tsx';
import { OrdersSavedViews } from './orders-saved-views.tsx';
import { LIST_KEY, queryOf, type SavedFilter, type SavedFiltersAnswer } from './orders-saved.ts';
import { OrdersSortPanel } from './orders-sort-panel.tsx';
import { OrdersTable } from './orders-table.tsx';
import { FILTERS, type AdminOrderPage, type OrderCounts, type StatusFilter } from './types.ts';

/** Rows that can be ticked one by one; "Select all matching" has no such limit. */
const SELECTION_MAX = 100;
const OPEN_ENDED = Number.MAX_SAFE_INTEGER;

type Failure = 'refused' | 'search-unavailable' | 'unavailable';

function failureOf(status: number, code: string): Failure {
  // The API refused the query itself: asking again can never work.
  if (code === 'validation.failed' || code === 'ordering.too-deep') return 'refused';
  if (status === 503 && code === 'ordering.search-unavailable') return 'search-unavailable';
  return 'unavailable';
}

const noActions = () => [];

// The query rules of the kit hook, kept at module level so they stay the same between renders.
const forView = (view: string): Query => ({ ...DEFAULT_QUERY, tab: view as StatusFilter });
const withView = (current: Query, view: string): Query => ({
  ...current,
  tab: view as StatusFilter,
});
const searchOf = (current: Query): string => current.q;
// One character asks for nothing: the query keeps the search it had.
const withSearch = (current: Query, text: string): Query =>
  routeSearch(text).kind === 'too-short' ? current : { ...current, q: text };

function countOf(counts: OrderCounts, tab: StatusFilter): number {
  switch (tab) {
    case 'all':
      return counts.pendingPayment + counts.confirmed + counts.cancelled;
    case 'pending-payment':
      return counts.pendingPayment;
    case 'confirmed':
      return counts.confirmed;
    case 'cancelled':
      return counts.cancelled;
  }
}

/**
 * The Market's orders (Orders; a super list): a tab for each status and for each saved filter,
 * one search box (an order id, or a customer or store name), the filter, sort and column panels with
 * their chips, then one page of orders. It follows the Market's List paging setting: page numbers
 * with a total, or Previous and next (the API answers whether a next page exists). The column
 * choice is the admin's own and lives in this browser's storage; a saved filter keeps the tab,
 * filters and sort on the server, for the admin or, with the share key, for everyone. Rows can be
 * selected; the Bulk action button has no action yet (Export follows with its endpoint).
 */
export function OrdersList({
  paging = 'prev-next',
  accountId,
  marketId,
  csrfToken = '',
  zone,
  customerAccountId,
}: {
  readonly paging?: ListPaging;
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken?: string;
  /** The IANA zone of the table's times and of the day filters (ADR-0005). */
  readonly zone: string;
  /**
   * The Orders tab of a customer's page: only this customer's orders (`accountId`, fixed, not a
   * chip), no Customer column, no saved filters (they belong to the Orders page) and no "select
   * all matching" (the export route takes no customer, so a bulk export goes by ticked ids).
   */
  readonly customerAccountId?: string;
}) {
  const t = useTranslations('orders');
  const ts = useTranslations('sales-lists');
  const tl = useTranslations('load');
  const daysWords = {
    range: (from: string, to: string) => t('days.range', { from, to }),
    from: (day: string) => t('days.from', { day }),
    until: (day: string) => t('days.until', { day }),
  };
  const locale = useLocale();
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

  const [answer, setAnswer] = useState<AdminOrderPage | null>(null);
  // The tab counts of the last answer: they stay while a search fails or a page loads.
  const [liveCounts, setCounts] = useState<OrderCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [hinted, setHinted] = useState(false);
  const [columns, setColumns] = useState<readonly OrderColumn[]>(DEFAULT_COLUMNS);
  // The saved filters: null until they load, and when they cannot (the page then has the status
  // tabs only).
  const [saved, setSaved] = useState<SavedFiltersAnswer | null>(null);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  const latest = useRef(0);
  // A customer's Orders tab keeps its own column choice: it never shows the Customer column, so
  // sharing the Orders page's choice would drop that column there.
  const storageKey = prefsKey(
    'admin',
    marketId,
    accountId,
    customerAccountId === undefined ? 'orders-columns' : 'customer-orders-columns',
  );
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);
  const backwards = rangeIsBackwards(query.days) && query.filters.placed === undefined;

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  const loadSaved = useCallback(async (): Promise<readonly SavedFilter[] | null> => {
    if (customerAccountId !== undefined) return null;
    const result = await callApi<SavedFiltersAnswer>(
      'GET',
      `ordering/admin/saved-filters?listKey=${LIST_KEY}`,
    );
    if (!result.ok || !Array.isArray(result.body?.items)) return null;
    setSaved(result.body);
    const items: readonly SavedFilter[] = result.body.items;
    return items;
  }, [customerAccountId]);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  // A saved tab that was deleted (here or by its owner) is no longer the one on show.
  useEffect(() => {
    if (savedId !== null && saved !== null && !saved.items.some((item) => item.id === savedId)) {
      forgetSaved();
    }
  }, [saved, savedId, forgetSaved]);

  // The date presets are read at each load (and each Try again), on the clock of the list's zone,
  // so a tab left open past midnight does not keep asking for yesterday's "Today".
  const load = useCallback(
    async (asked: Query) => {
      if (rangeIsBackwards(asked.days) && asked.filters.placed === undefined) {
        // An answer still on its way for the days as they were must not fill the list.
        latest.current += 1;
        setAnswer(null);
        setLoading(false);
        setFailure(null);
        return;
      }
      const asText = queryString(asked, { paging, zone, now: new Date() });
      const request =
        customerAccountId === undefined
          ? asText
          : [`accountId=${encodeURIComponent(customerAccountId)}`, asText]
              .filter(Boolean)
              .join('&');
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<AdminOrderPage>('GET', `ordering/admin/orders?${request}`);
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
    [paging, zone, customerAccountId],
  );

  // A saved filter is a tab of its own: it does not narrow the counts of the built-in tabs.
  const counts = useBaseTabCounts<OrderCounts>({
    savedId,
    live: liveCounts,
    load: async () => {
      const asText = queryString(DEFAULT_QUERY, { paging, zone, now: new Date() });
      const request =
        customerAccountId === undefined
          ? asText
          : [`accountId=${encodeURIComponent(customerAccountId)}`, asText]
              .filter(Boolean)
              .join('&');
      const result = await callApi<AdminOrderPage>('GET', `ordering/admin/orders?${request}`);
      return result.ok ? result.body.counts : null;
    },
  });

  // A query that is equal in content is not a new list: load again only when it changed.
  const queryNow = useRef(query);
  queryNow.current = query;
  const queryKey = JSON.stringify(query);
  useEffect(() => {
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
  const rows = answer?.orders;
  const pageIds = useMemo(() => rows?.map((row) => row.orderId) ?? [], [rows]);
  const selection = useRowSelection(pageIds, SELECTION_MAX, listKey);
  // On a customer's page every row is that customer's: the Customer column says nothing.
  const shownColumns =
    customerAccountId === undefined ? columns : columns.filter((column) => column !== 'customer');
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

  // A page past the end (rows were removed meanwhile) goes back to the last one that has rows.
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.orders.length > 0) return;
    if (answer.page !== null && answer.page > 1) {
      const last =
        mode === 'pages'
          ? Math.max(1, Math.ceil((answer.total ?? 0) / (answer.pageSize ?? PAGE_SIZE)))
          : answer.page - 1;
      goToPage(Math.min(last, answer.page - 1));
    }
  }, [answer, loading, failure, mode, goToPage]);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const route = routeSearch(query.q);
  const draftRoute = routeSearch(draft);
  // The hint about the typed text waits for the box to lose focus or Enter, so it is not read out
  // at the first keystroke of every search.
  const showHint = hinted && draftRoute.kind === 'too-short';

  const saveColumns = (next: readonly OrderColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => reset({ q: '', filters: {}, days: null });
  const withoutFilter = (field: keyof Query['filters']): Query['filters'] =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const chips = [
    ...(route.kind === 'q' || route.kind === 'search'
      ? [
          {
            key: 'search',
            label: t('chip-search', { text: route.value }),
            onRemove: () => reset({ q: '' }),
          },
        ]
      : []),
    ...(query.filters.paymentState === undefined
      ? []
      : [
          {
            key: 'paymentState',
            label: ts('chip', {
              field: t('filter.name.paymentState'),
              value: t(`payment.${query.filters.paymentState}`),
            }),
            onRemove: () => change({ filters: withoutFilter('paymentState') }),
          },
        ]),
    ...(query.filters.fulfilment === undefined
      ? []
      : [
          {
            key: 'fulfilment',
            label: ts('chip', {
              field: t('filter.name.fulfilment'),
              value: t(`fulfilment.${query.filters.fulfilment}`),
            }),
            onRemove: () => change({ filters: withoutFilter('fulfilment') }),
          },
        ]),
    ...(query.filters.placed === undefined
      ? query.days === null
        ? []
        : [
            {
              key: 'days',
              label: ts('chip', {
                field: t('filter.name.placed'),
                value: daysLabel(query.days, daysWords),
              }),
              onRemove: () => change({ days: null }),
            },
          ]
      : [
          {
            key: 'placed',
            label: ts('chip', {
              field: t('filter.name.placed'),
              value: ts(`date-preset.${query.filters.placed}`),
            }),
            onRemove: () => change({ filters: withoutFilter('placed') }),
          },
        ]),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;

  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;
  const rowActions = useOrderRowActions(
    customerAccountId === undefined ? undefined : { accountId: customerAccountId, tab: 'orders' },
  );
  const summary = [
    t(query.tab === 'all' ? 'tab.all' : `status.${query.tab}`),
    ...chips.filter((chip) => chip.key !== 'search').map((chip) => chip.label),
  ].join(' · ');

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered || backwards ? 'search' : 'receipt'}
      title={filtered || backwards ? t('empty.filtered.title') : t(`empty.${query.tab}.title`)}
      body={filtered || backwards ? t('empty.filtered.body') : t(`empty.${query.tab}.body`)}
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
  const searchDown = failure === 'search-unavailable';
  const shown = answer?.orders ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.orderId));
  const moreThanPage =
    mode === 'pages' ? (answer?.total ?? 0) > shown.length : answer?.hasNext === true || page > 1;
  const start = (page - 1) * PAGE_SIZE;
  const sortOrder = t(
    `sort.${query.sort === 'total' ? 'amount' : 'date'}.${query.direction === 'desc' ? 'first' : 'second'}`,
  );

  const table = (
    <div className="flex flex-col gap-4">
      {mode === 'pages' && (answer?.total ?? 0) > MAX_PAGED_ROWS ? (
        <p role="status" className="rounded-lg border border-line bg-muted px-4 py-2 text-sm">
          {t('too-many', { limit: number(MAX_PAGED_ROWS) })}
        </p>
      ) : null}
      {answer?.searchScope === 'stores' && failure === null ? (
        <p role="status" className="rounded-lg border border-line bg-muted px-4 py-2 text-sm">
          {t('search-stores')}
        </p>
      ) : null}
      {answer?.searchCapped === true && failure === null ? (
        <p role="status" className="rounded-lg border border-line bg-muted px-4 py-2 text-sm">
          {t('search-capped')}
        </p>
      ) : null}
      <SelectionBar
        active={selection.selected.size > 0 || selection.allMatching}
        allMatching={selection.allMatching}
        canSelectAll={
          customerAccountId === undefined && wholePageTicked && moreThanPage && failure === null
        }
        labels={{
          selected: t('selection.selected', { count: selection.selected.size }),
          all: total === null ? t('selection.all-open') : t('selection.all', { count: total }),
          selectAll:
            total === null
              ? t('selection.select-all-open')
              : t('selection.select-all', { count: total }),
          clear: t('selection.clear'),
        }}
        onSelectAll={selection.selectAllMatching}
        onClear={selection.clear}
      />
      <div ref={listTop} tabIndex={-1} className="outline-none">
        <OrdersTable
          rows={shown}
          columns={shownColumns}
          zone={zone}
          {...(customerAccountId === undefined
            ? {}
            : { fromCustomer: { accountId: customerAccountId, tab: 'orders' as const } })}
          empty={empty}
          skeletonRows={skeleton ? listSkeletonRowCount(PAGE_SIZE) : undefined}
          // Rows kept after a failed refresh belong to another list than the query: no actions.
          actions={failure === null ? rowActions : noActions}
          selection={selection}
        />
      </div>
    </div>
  );

  return (
    <SuperList
      heading={{
        info: t(customerAccountId === undefined ? 'intro' : 'customer-intro'),
        note: t('zone-note', { zone }),
        actions: (
          <OrdersBulk
            selection={{ ids: [...selection.selected], allMatching: selection.allMatching, total }}
            exportQuery={() => {
              // The route takes the filters only; the relay drops the rest, but say it here too.
              const params = new URLSearchParams(
                queryString(query, { paging: 'prev-next', zone, now: new Date() }),
              );
              for (const key of ['page', 'pageSize', 'paging', 'sort', 'direction', 'search']) {
                params.delete(key);
              }
              return params.toString();
            }}
            columns={shownColumns}
            nameSearch={routeSearch(query.q).kind === 'search'}
            empty={answer !== null && shown.length === 0}
          />
        ),
      }}
      views={{
        label: t('tabs'),
        activeId: savedId ?? query.tab,
        onSelect: (id) => {
          const filter = saved?.items.find((item) => item.id === id);
          if (filter !== undefined) openSavedTab(id, queryOf(filter.payload));
          else openView(id);
        },
        items: [
          ...FILTERS.map((id) => ({
            id,
            label: `${t(id === 'all' ? 'tab.all' : `status.${id}`)}${
              counts === null ? '' : ` (${number(countOf(counts, id))})`
            }`,
          })),
          ...(saved?.items ?? []).map((item) => ({ id: item.id, label: item.name })),
        ],
        manage:
          saved === null
            ? null
            : { label: t('saved.manage-link'), onClick: () => setDialog('manage') },
      }}
      search={{
        label: t('search.label'),
        placeholder: t('search.placeholder'),
        value: draft,
        maxLength: SEARCH_MAX,
        onChange: (value) => {
          setHinted(false);
          setDraft(value);
        },
        onBlur: () => setHinted(true),
        onSubmit: (value) => {
          setHinted(true);
          if (routeSearch(value).kind === 'too-short') return;
          change({ q: value });
        },
        extra: showHint ? (
          <p role="status" className="w-full text-sm text-fg-muted">
            {t('search.too-short')}
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
              change({ filters, days: filters.placed === undefined ? query.days : null })
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
        label: ts('columns.button'),
        panel: (close) => (
          <OrdersColumnsPanel
            columns={shownColumns}
            onSave={saveColumns}
            close={close}
            {...(customerAccountId === undefined ? {} : { without: 'customer' as const })}
          />
        ),
      }}
      sortedLine={t('sorted', { field: t(`sort.field.${query.sort}`), order: sortOrder })}
      chips={
        filtered
          ? {
              chips,
              clearAll: { label: ts('clear-all'), onClick: clearAll },
              ...(saved === null || savedId !== null
                ? {}
                : { save: { label: t('saved.save-link'), onClick: () => setDialog('save') } }),
              status: total === null || failure !== null ? '' : t('match', { count: total }),
            }
          : null
      }
      failure={
        failure === null || searchDown
          ? null
          : failure === 'refused'
            ? // Asking again cannot work: no Try again, the words say what to change.
              { message: t('error.refused') }
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
      ready={answer !== null || searchDown || backwards}
      table={
        searchDown ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-4">
            <span>{t('error.search-unavailable')}</span>
            <Button variant="secondary" onClick={() => void load(query)}>
              {tl('retry')}
            </Button>
          </div>
        ) : (
          table
        )
      }
      pagination={
        answer !== null && answer.orders.length > 0 && failure === null
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
                  : answer.hasNext
                    ? page * PAGE_SIZE + 1
                    : (page - 1) * PAGE_SIZE + answer.orders.length,
              maxRows: mode === 'pages' ? MAX_PAGED_ROWS : OPEN_ENDED,
              // Previous and next has no total, so no range line.
              range:
                mode === 'pages' && answer.total !== null
                  ? t('range', {
                      from: number(start + 1),
                      to: number(start + answer.orders.length),
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
        saved === null ? null : (
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
        )
      }
    />
  );
}
