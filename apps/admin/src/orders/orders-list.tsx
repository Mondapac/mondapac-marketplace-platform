'use client';

import {
  Banner,
  Button,
  ColumnPickerPanel,
  EmptyState,
  Icon,
  LoadError,
  Pagination,
  PrevNext,
  Popover,
  Select,
  SkeletonRows,
  Tabs,
  TextField,
  browserStorage,
  prefsKey,
  readIds,
  writeIds,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
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
  FULFILMENT_FILTERS,
  MAX_PAGED_ROWS,
  NO_FILTERS,
  PAGE_SIZE,
  PAYMENT_FILTERS,
  SORTS,
  pageCountOf,
  queryOf,
  rangeIsBackwards,
  type ListPaging,
  type OrderFilters,
  type SortId,
} from './orders-query.ts';
import { FILTERS, type AdminOrder, type AdminOrderPage } from './types.ts';

/**
 * The Market's orders (read-only): a tab for each status and for each saved filter, filters, a
 * sort, the column picker, and either page numbers with the total or Previous and next, as the
 * Market's List paging setting says. Previous and next keeps to newest first and walks the API's
 * cursors, so it works for any number of orders. The column choice is the admin's own and lives in
 * this browser's storage (the list works the same when storage is missing); a saved filter keeps
 * the tab, filters and sort on the server, for the admin or, with the share key, for everyone.
 */
export function OrdersList({
  paging = 'prev-next',
  accountId,
  marketId,
  csrfToken = '',
  zone,
}: {
  readonly paging?: ListPaging;
  readonly accountId: string;
  readonly marketId: string;
  readonly csrfToken?: string;
  /** The IANA zone of the table's times and of the day filters (ADR-0005). */
  readonly zone: string;
}) {
  const t = useTranslations('orders');
  const tl = useTranslations('load');
  const locale = useLocale();
  const [filters, setFilters] = useState<OrderFilters>(NO_FILTERS);
  const [sort, setSort] = useState<SortId>('newest');
  const [page, setPage] = useState(1);
  // Previous and next: the cursor that opened each page seen so far (the first page has none).
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const [rows, setRows] = useState<readonly AdminOrder[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);
  const [columns, setColumns] = useState<readonly OrderColumn[]>(DEFAULT_COLUMNS);
  // The saved filters: null until they load, and when they cannot (the page then has the status
  // tabs only). `savedId` is the saved tab the page is showing.
  const [saved, setSaved] = useState<SavedFiltersAnswer | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  const storageKey = prefsKey('admin', marketId, accountId, 'orders-columns');
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);
  const backwards = rangeIsBackwards(filters);
  const cursor = cursors[cursors.length - 1] ?? null;

  const load = useCallback(async () => {
    if (backwards) {
      // An answer still on its way for the days as they were must not fill the list.
      latest.current += 1;
      setRows([]);
      setNext(null);
      setTotal(null);
      setLoading(false);
      setFailed(false);
      return;
    }
    const ticket = ++latest.current;
    setLoading(true);
    setFailed(false);
    const text = queryOf(
      filters,
      zone,
      paging === 'pages' ? { paging, page, sort } : { paging, cursor },
    );
    const result = await callApi<AdminOrderPage>(
      'GET',
      `ordering/admin/orders${text === '' ? '' : `?${text}`}`,
    );
    if (ticket !== latest.current) return;
    setLoading(false);
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setFailed(true);
      setRows([]);
      setNext(null);
      setTotal(null);
      return;
    }
    setRows(result.body.orders);
    setNext(result.body.nextCursor);
    setTotal(result.body.total ?? null);
  }, [filters, zone, paging, page, sort, cursor, backwards]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  const loadSaved = useCallback(async (): Promise<readonly SavedFilter[] | null> => {
    const result = await callApi<SavedFiltersAnswer>(
      'GET',
      `ordering/admin/saved-filters?listKey=${LIST_KEY}`,
    );
    if (!result.ok || !Array.isArray(result.body?.items)) return null;
    setSaved(result.body);
    // A saved filter that was deleted (here or by its owner) is no longer the one on show.
    setSavedId((current) =>
      current !== null && result.body.items.some((item) => item.id === current) ? current : null,
    );
    const items: readonly SavedFilter[] = result.body.items;
    return items;
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

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
  }, [loading, rows]);

  // Any change of what is asked for starts again at the first page, and leaves the saved filter
  // on show (the page is no longer it).
  const change = (patch: Partial<OrderFilters>) => {
    setSavedId(null);
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
    setCursors([null]);
  };
  const openSaved = (id: string) => {
    const filter = saved?.items.find((item) => item.id === id);
    if (filter === undefined) return;
    const opened = stateOf(filter.payload);
    setFilters(opened.filters);
    // Previous and next keeps to newest first: a saved sort needs page numbers.
    setSort(paging === 'pages' ? opened.sort : 'newest');
    setPage(1);
    setCursors([null]);
    setSavedId(id);
  };
  const number = (n: number) => n.toLocaleString(locale);
  const pageCount = total === null ? 1 : pageCountOf(total);
  const first = total === null ? 0 : (page - 1) * PAGE_SIZE + 1;
  const cut = total !== null && total > MAX_PAGED_ROWS;
  const filtered =
    filters.paymentState !== '' ||
    filters.fulfilment !== '' ||
    filters.from !== '' ||
    filters.to !== '';
  const status = filters.status;
  const somethingToSave = filtered || status !== 'all' || (paging === 'pages' && sort !== 'newest');
  const summary = [
    t(status === 'all' ? 'tab.all' : `status.${status}`),
    ...(filters.paymentState === ''
      ? []
      : [`${t('filters.payment')}: ${t(`payment.${filters.paymentState}`)}`]),
    ...(filters.fulfilment === ''
      ? []
      : [`${t('filters.fulfilment')}: ${t(`fulfilment.${filters.fulfilment}`)}`]),
    ...(filters.from === '' ? [] : [`${t('filters.from')}: ${filters.from}`]),
    ...(filters.to === '' ? [] : [`${t('filters.to')}: ${filters.to}`]),
    ...(paging === 'pages' && sort !== 'newest'
      ? [`${t('sort.label')}: ${t(`sort.${sort}`)}`]
      : []),
  ].join(' · ');

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      <p className="text-sm text-fg-muted">{t('zone-note', { zone })}</p>
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1">
          <Tabs
            label={t('tabs')}
            activeId={savedId ?? status}
            onSelect={(id) => {
              if (saved?.items.some((item) => item.id === id)) openSaved(id);
              else change({ status: id });
            }}
            items={[
              ...FILTERS.map((id) => ({
                id,
                label: t(id === 'all' ? 'tab.all' : `status.${id}`),
              })),
              ...(saved?.items ?? []).map((item) => ({ id: item.id, label: item.name })),
            ]}
          />
        </div>
        {saved === null ? null : (
          <div className="flex shrink-0 items-center border-b border-line ps-3">
            <Button
              variant="link"
              className="min-h-(--mp-size-control-sm)"
              onClick={() => setDialog('manage')}
            >
              <Icon name="sliders" />
              <span className="sr-only sm:not-sr-only">{t('saved.manage-link')}</span>
            </Button>
          </div>
        )}
      </div>
      <div
        role="group"
        aria-label={t('filters.group')}
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
      >
        <Select
          label={t('filters.payment')}
          placeholder={t('filters.any')}
          value={filters.paymentState}
          options={PAYMENT_FILTERS.map((id) => ({ value: id, label: t(`payment.${id}`) }))}
          onChange={(event) => change({ paymentState: event.target.value })}
        />
        <Select
          label={t('filters.fulfilment')}
          placeholder={t('filters.any')}
          value={filters.fulfilment}
          options={FULFILMENT_FILTERS.map((id) => ({ value: id, label: t(`fulfilment.${id}`) }))}
          onChange={(event) => change({ fulfilment: event.target.value })}
        />
        <TextField
          type="date"
          label={t('filters.from')}
          value={filters.from}
          onChange={(event) => change({ from: event.target.value })}
        />
        <TextField
          type="date"
          label={t('filters.to')}
          value={filters.to}
          error={backwards ? t('filters.backwards') : undefined}
          onChange={(event) => change({ to: event.target.value })}
        />
        {paging === 'pages' ? (
          <Select
            label={t('sort.label')}
            value={sort}
            options={SORTS.map((id) => ({ value: id, label: t(`sort.${id}`) }))}
            onChange={(event) => {
              setSavedId(null);
              setSort(event.target.value as SortId);
              setPage(1);
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
          <Button
            variant="secondary"
            onClick={() => change({ paymentState: '', fulfilment: '', from: '', to: '' })}
          >
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
      </div>
      {failed ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
          message={t('error.unavailable')}
          retryLabel={tl('retry')}
          onRetry={() => void load()}
        />
      ) : null}
      {total !== null && rows.length > 0 ? (
        <p className="text-sm text-fg-muted" aria-live="polite">
          {t('range', {
            from: number(first),
            to: number(first + rows.length - 1),
            total: number(total),
          })}
        </p>
      ) : null}
      {rows.length > 0 ? (
        <div ref={listTop} tabIndex={-1} className="outline-none">
          <OrdersTable rows={rows} columns={columns} zone={zone} />
        </div>
      ) : null}
      {!loading && !failed && rows.length === 0 ? (
        <EmptyState
          icon="receipt"
          title={t(filtered || backwards ? 'empty.filtered.title' : `empty.${status}.title`)}
          body={t(filtered || backwards ? 'empty.filtered.body' : `empty.${status}.body`)}
        />
      ) : null}
      {loading ? <SkeletonRows label={t('loading')} rows={rows.length > 0 ? 1 : 3} /> : null}
      {cut ? <Banner tone="info">{t('too-many', { limit: number(MAX_PAGED_ROWS) })}</Banner> : null}
      {paging === 'pages' ? (
        <Pagination
          page={page}
          pageCount={pageCount}
          onPage={(n) => {
            focusList.current = true;
            setPage(n);
          }}
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
          onPrevious={() => {
            focusList.current = true;
            setCursors((current) => current.slice(0, -1));
          }}
          onNext={() => {
            if (next === null) return;
            focusList.current = true;
            setCursors((current) => [...current, next]);
          }}
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
          filters={filters}
          sort={sort}
          summary={summary}
          saved={saved}
          csrfToken={csrfToken}
          onSaved={(filter) => {
            void loadSaved().then((items) => {
              // Only a filter that is in the reloaded list can be the tab on show.
              if (items?.some((item) => item.id === filter.id) === true) setSavedId(filter.id);
            });
          }}
          onChanged={() => void loadSaved()}
        />
      )}
    </div>
  );
}
