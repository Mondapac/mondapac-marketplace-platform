'use client';

import {
  Banner,
  Button,
  ColumnPickerPanel,
  EmptyState,
  Icon,
  Pagination,
  PrevNext,
  Popover,
  Select,
  Tabs,
  TextField,
  browserStorage,
  prefsKey,
  readIds,
  writeIds,
} from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { resolveZone } from '../price/zone-time.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { OrdersBoard } from './orders-board.tsx';
import {
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  cleanColumns,
  type OrderColumn,
} from './orders-columns.ts';
import { OrdersSavedViews } from './orders-saved-views.tsx';
import { LIST_KEY, stateOf, type SavedFilter, type SavedFiltersAnswer } from './orders-saved.ts';
import { OrdersTable } from './orders-table.tsx';
import {
  MAX_PAGED_ROWS,
  NO_DAYS,
  PAGE_SIZE,
  SORTS,
  pageCountOf,
  queryOf,
  rangeIsBackwards,
  type Days,
  type ListPaging,
  type SortId,
} from './orders-query.ts';
import { FULFILMENT_FILTERS, type FulfilmentFilter, type SellerOrderPage } from './types.ts';

export type OrdersView = 'table' | 'board';

/**
 * The seller's paid orders: a fulfilment tab, a payment-day range, a sort and either page numbers
 * with the total or "Show more" by cursor, as the Market's List paging setting says. The tab is the
 * API's `status` parameter, so it lists every order in that state, not only the ones loaded so far.
 * "Show more" keeps to newest first and works for any number of orders.
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
  const locale = useLocale();
  // The seller's own working zone (UTC when it could not be read): the table's times and the
  // days of the date filters are both on this clock (ADR-0005).
  const zone = resolveZone(useTimeZone());
  const [view, setView] = useState<OrdersView>(initialView);
  // What the rows on screen answer. Nothing here changes until an answer arrives, so a failed
  // request leaves the old rows under the old tab, days, sort and range line.
  const [orders, setOrders] = useState(initial.sellerOrders);
  const [next, setNext] = useState(initial.nextCursor);
  const [total, setTotal] = useState<number | null>(initial.total ?? null);
  const [filter, setFilter] = useState<FulfilmentFilter>('all');
  // What the date and sort controls show. They change at once, so a field never snaps back while
  // an answer is on its way, and a second quick change builds on the first, not on old days.
  const [draftDays, setDraftDays] = useState<Days>(NO_DAYS);
  const [draftSort, setDraftSort] = useState<SortId>('newest');
  const [page, setPage] = useState(1);
  // Previous and next: the cursor that opened each page seen so far (the first page has none).
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [columns, setColumns] = useState<readonly OrderColumn[]>(DEFAULT_COLUMNS);
  // The saved filters: null until they load, and when they cannot (the page then has the
  // fulfilment tabs only). `savedId` is the saved tab the page is showing.
  const [saved, setSaved] = useState<SavedFiltersAnswer | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  const storageKey = prefsKey('seller', marketId, accountId, 'orders-columns');
  // Only the newest question may fill the list: a slow answer for old filters is dropped.
  const latest = useRef(0);
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);
  const backwards = rangeIsBackwards(draftDays);
  const number = (n: number) => n.toLocaleString(locale);

  const loadSaved = useCallback(async (): Promise<readonly SavedFilter[] | null> => {
    const result = await callApi<SavedFiltersAnswer>(
      'GET',
      `ordering/seller/saved-filters?listKey=${LIST_KEY}`,
    );
    if (!result.ok || !Array.isArray(result.body?.items)) return null;
    setSaved(result.body);
    // A saved filter that was deleted is no longer the one on show.
    setSavedId((current) =>
      current !== null && result.body.items.some((item) => item.id === current) ? current : null,
    );
    const items: readonly SavedFilter[] = result.body.items;
    return items;
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  const saveColumns = (next: readonly string[]) => {
    const chosen = cleanColumns(next);
    setColumns(chosen);
    writeIds(browserStorage(), storageKey, chosen);
  };

  useEffect(() => {
    if (!loading && focusList.current) {
      focusList.current = false;
      listTop.current?.focus();
    }
  }, [loading, orders]);

  /** Asks for what the controls would say; the screen takes it over only when the answer is in. */
  async function ask(want: {
    filter?: FulfilmentFilter;
    days?: Days;
    sort?: SortId;
    page?: number;
    cursors?: readonly (string | null)[];
    focus?: boolean;
    /** The saved tab being opened; a change of tab, days or sort leaves the saved tab. */
    savedId?: string;
  }) {
    const nextFilter = want.filter ?? filter;
    const nextDays = want.days ?? draftDays;
    const nextSort = want.sort ?? draftSort;
    const nextPage = want.page ?? 1;
    const nextCursors = want.cursors ?? [null];
    // Page changes stay on the saved tab; any other change of what is asked for leaves it.
    const nextSaved =
      want.savedId ?? (want.page !== undefined || want.cursors !== undefined ? savedId : null);
    const ticket = ++latest.current;
    setFailed(false);
    if (rangeIsBackwards(nextDays)) {
      // Nothing matches; an answer still on its way for the days as they were must not fill it.
      setSavedId(null);
      setOrders([]);
      setNext(null);
      setTotal(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const cursor = nextCursors[nextCursors.length - 1] ?? null;
    const result = await callApi<SellerOrderPage>(
      'GET',
      queryOf(
        nextFilter,
        nextDays,
        zone,
        paging === 'pages' ? { paging, page: nextPage, sort: nextSort } : { paging, cursor },
      ),
    );
    if (ticket !== latest.current) return;
    if (!result.ok) {
      setLoading(false);
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setFailed(true);
      return;
    }
    focusList.current = want.focus === true;
    setFilter(nextFilter);
    setSavedId(nextSaved);
    setPage(nextPage);
    setCursors(nextCursors);
    setOrders(result.body.sellerOrders);
    setNext(result.body.nextCursor);
    setTotal(result.body.total ?? null);
    setLoading(false);
  }

  function changeDays(chosen: Days) {
    setDraftDays(chosen);
    void ask({ days: chosen });
  }

  const openSaved = (id: string) => {
    const view = saved?.items.find((item) => item.id === id);
    if (view === undefined || loading) return;
    const opened = stateOf(view.payload);
    // Previous and next keeps to newest first: a saved sort needs page numbers.
    setDraftDays(opened.days);
    setDraftSort(paging === 'pages' ? opened.sort : 'newest');
    void ask({
      filter: opened.filter,
      days: opened.days,
      sort: paging === 'pages' ? opened.sort : 'newest',
      savedId: id,
    });
  };

  const filtered = draftDays.from !== '' || draftDays.to !== '';
  const somethingToSave =
    filtered || filter !== 'all' || (paging === 'pages' && draftSort !== 'newest');
  const summary = [
    t(filter === 'all' || filter === 'to-ship' ? `filter.${filter}` : `status.${filter}`),
    ...(draftDays.from === '' ? [] : [`${t('filters.from')}: ${draftDays.from}`]),
    ...(draftDays.to === '' ? [] : [`${t('filters.to')}: ${draftDays.to}`]),
    ...(paging === 'pages' && draftSort !== 'newest'
      ? [`${t('sort.label')}: ${t(`sort.${draftSort}`)}`]
      : []),
  ].join(' · ');
  const everyState = filter === 'all' && !filtered;
  const pageCount = total === null ? 1 : pageCountOf(total);
  const first = total === null ? 0 : (page - 1) * PAGE_SIZE + 1;
  const cut = total !== null && total > MAX_PAGED_ROWS;
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
        <p className="text-fg-muted">{t('intro')}</p>
        {toggle}
        <OrdersBoard />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      {orders.length > 0 || !everyState ? toggle : null}
      {orders.length === 0 && everyState && !loading && !failed ? (
        <EmptyState icon="clipboard" title={t('empty-state.title')} body={t('empty-state.body')} />
      ) : (
        <>
          <Tabs
            label={t('filter.label')}
            activeId={savedId ?? filter}
            onSelect={(id) => {
              if (saved?.items.some((item) => item.id === id)) openSaved(id);
              else if ((id !== filter || savedId !== null) && !loading) {
                void ask({ filter: id as FulfilmentFilter });
              }
            }}
            items={[
              ...FULFILMENT_FILTERS.map((id) => ({
                id,
                label: t(id === 'all' || id === 'to-ship' ? `filter.${id}` : `status.${id}`),
              })),
              ...(saved?.items ?? []).map((item) => ({ id: item.id, label: item.name })),
            ]}
          />
          <div
            role="group"
            aria-label={t('filters.group')}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <TextField
              type="date"
              label={t('filters.from')}
              value={draftDays.from}
              onChange={(event) => changeDays({ ...draftDays, from: event.target.value })}
            />
            <TextField
              type="date"
              label={t('filters.to')}
              value={draftDays.to}
              error={backwards ? t('filters.backwards') : undefined}
              onChange={(event) => changeDays({ ...draftDays, to: event.target.value })}
            />
            {paging === 'pages' ? (
              <Select
                label={t('sort.label')}
                value={draftSort}
                options={SORTS.map((id) => ({ value: id, label: t(`sort.${id}`) }))}
                onChange={(event) => {
                  const chosen = event.target.value as SortId;
                  setDraftSort(chosen);
                  void ask({ sort: chosen });
                }}
              />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Popover label={t('columns.button')} icon="columns" width="md">
              {(close) => (
                <ColumnPickerPanel
                  all={OPTIONAL_COLUMNS}
                  fixed={[{ id: 'order', label: t('col.order') }]}
                  shown={columns}
                  defaults={DEFAULT_COLUMNS}
                  labelOf={(column) => t(`col.${column}`)}
                  labels={{
                    title: t('columns.title'),
                    help: t('columns.help'),
                    always: t('columns.always'),
                    up: (column) => t('columns.up', { column }),
                    down: (column) => t('columns.down', { column }),
                    reset: t('columns.reset'),
                    save: t('columns.save'),
                  }}
                  onSave={saveColumns}
                  close={close}
                />
              )}
            </Popover>
            {filtered ? (
              <Button variant="secondary" onClick={() => changeDays(NO_DAYS)}>
                {t('filters.clear')}
              </Button>
            ) : null}
            {saved === null || savedId !== null || !somethingToSave ? null : (
              <Button
                variant="link"
                className="min-h-(--mp-size-control-sm)"
                onClick={() => setDialog('save')}
              >
                <Icon name="star" />
                {t('saved.save-link')}
              </Button>
            )}
            {saved === null ? null : (
              <Button
                variant="link"
                className="min-h-(--mp-size-control-sm)"
                onClick={() => setDialog('manage')}
              >
                <Icon name="sliders" />
                {t('saved.manage-link')}
              </Button>
            )}
          </div>
          {total !== null && orders.length > 0 ? (
            <p className="text-sm text-fg-muted" aria-live="polite">
              {t('range', {
                from: number(first),
                to: number(first + orders.length - 1),
                total: number(total),
              })}
            </p>
          ) : null}
          {loading ? (
            <p className="text-sm text-fg-muted" role="status">
              {t('loading')}
            </p>
          ) : null}
          {failed ? <Banner tone="critical">{t('error.unavailable')}</Banner> : null}
          {orders.length === 0 && !loading && !failed ? (
            <EmptyState
              icon="clipboard"
              title={t('filter.empty.title')}
              body={t('filter.empty.body')}
            />
          ) : orders.length > 0 ? (
            <div ref={listTop} tabIndex={-1} aria-busy={loading} className="outline-none">
              <OrdersTable orders={orders} columns={columns} />
            </div>
          ) : null}
        </>
      )}
      {cut ? <Banner tone="info">{t('too-many', { limit: number(MAX_PAGED_ROWS) })}</Banner> : null}
      {paging === 'pages' ? (
        <Pagination
          page={page}
          pageCount={pageCount}
          onPage={(n) => void ask({ page: n, focus: true })}
          disabled={loading}
          labels={{
            nav: t('paging.nav'),
            previous: t('paging.previous'),
            next: t('paging.next'),
            page: (n) => t('paging.page', { n }),
          }}
        />
      ) : (
        <PrevNext
          hasPrevious={cursors.length > 1}
          hasNext={next !== null}
          disabled={loading}
          onPrevious={() => void ask({ cursors: cursors.slice(0, -1), focus: true })}
          onNext={() => next !== null && void ask({ cursors: [...cursors, next], focus: true })}
          labels={{
            nav: t('paging.nav'),
            previous: t('paging.previous'),
            next: t('paging.next'),
          }}
        />
      )}
      {saved === null ? null : (
        <OrdersSavedViews
          dialog={dialog}
          onClose={() => setDialog(null)}
          filter={filter}
          days={draftDays}
          sort={draftSort}
          summary={summary}
          saved={saved}
          csrfToken={csrfToken}
          onSaved={(view) => {
            void loadSaved().then((items) => {
              // Only a filter that is in the reloaded list can be the tab on show.
              if (items?.some((item) => item.id === view.id) === true) setSavedId(view.id);
            });
          }}
          onChanged={() => void loadSaved()}
        />
      )}
    </div>
  );
}
