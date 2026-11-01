'use client';

import {
  Banner,
  Button,
  EmptyState,
  LoadError,
  Pagination,
  PrevNext,
  Select,
  SkeletonRows,
  Tabs,
  TextField,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
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
 * The Market's orders (read-only): a tab for each status, filters, a sort, and either page numbers
 * with the total or Previous and next, as the Market's List paging setting says. Previous and next
 * keeps to newest first and walks the API's cursors, so it works for any number of orders.
 */
export function OrdersList({ paging = 'prev-next' }: { readonly paging?: ListPaging }) {
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
    const text = queryOf(filters, paging === 'pages' ? { paging, page, sort } : { paging, cursor });
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
  }, [filters, paging, page, sort, cursor, backwards]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any change of what is asked for starts again at the first page.
  const change = (patch: Partial<OrderFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
    setCursors([null]);
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

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      <Tabs
        label={t('tabs')}
        activeId={status}
        onSelect={(id) => change({ status: id })}
        items={FILTERS.map((id) => ({ id, label: t(id === 'all' ? 'tab.all' : `status.${id}`) }))}
      />
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
              setSort(event.target.value as SortId);
              setPage(1);
            }}
          />
        ) : null}
      </div>
      {filtered ? (
        <div>
          <Button
            variant="secondary"
            onClick={() => change({ paymentState: '', fulfilment: '', from: '', to: '' })}
          >
            {t('filters.clear')}
          </Button>
        </div>
      ) : null}
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
      {rows.length > 0 ? <OrdersTable rows={rows} /> : null}
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
          onPage={setPage}
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
          onPrevious={() => setCursors((current) => current.slice(0, -1))}
          onNext={() => next !== null && setCursors((current) => [...current, next])}
          labels={{
            nav: t('paging.nav'),
            previous: t('paging.previous'),
            next: t('paging.next'),
          }}
        />
      )}
    </div>
  );
}
