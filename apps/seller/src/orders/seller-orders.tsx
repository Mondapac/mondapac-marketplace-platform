'use client';

import { Banner, Button, EmptyState, Pagination, Select, Tabs, TextField } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
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

/**
 * The seller's paid orders: a fulfilment tab, a payment-day range, a sort and either page numbers
 * with the total or "Show more" by cursor, as the Market's List paging setting says. The tab is the
 * API's `status` parameter, so it lists every order in that state, not only the ones loaded so far.
 * "Show more" keeps to newest first and works for any number of orders.
 */
export function SellerOrders({
  initial,
  paging = 'prev-next',
}: {
  readonly initial: SellerOrderPage;
  readonly paging?: ListPaging;
}) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const [orders, setOrders] = useState(initial.sellerOrders);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [total, setTotal] = useState<number | null>(initial.total ?? null);
  const [filter, setFilter] = useState<FulfilmentFilter>('all');
  const [days, setDays] = useState<Days>(NO_DAYS);
  const [sort, setSort] = useState<SortId>('newest');
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [switching, setSwitching] = useState(false);
  // Only the newest question may fill the list: a slow answer for old filters is dropped.
  const latest = useRef(0);
  const backwards = rangeIsBackwards(days);
  const number = (n: number) => n.toLocaleString(locale);

  const modeFor = (nextPage: number, nextSort: SortId, after: string | null) =>
    paging === 'pages'
      ? ({ paging, page: nextPage, sort: nextSort } as const)
      : ({ paging, cursor: after } as const);

  async function loadMore() {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    const result = await callApi<SellerOrderPage>(
      'GET',
      queryOf(filter, days, modeFor(1, sort, cursor)),
    );
    setLoadingMore(false);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setMoreFailed(true);
      return;
    }
    const known = new Set(orders.map((order) => order.sellerOrderId));
    setOrders([...orders, ...result.body.sellerOrders.filter((o) => !known.has(o.sellerOrderId))]);
    setCursor(result.body.nextCursor);
  }

  /** Asks the API for the first page (or the given page) of what the controls now say. */
  async function reload(next: {
    filter?: FulfilmentFilter;
    days?: Days;
    sort?: SortId;
    page?: number;
  }) {
    const nextFilter = next.filter ?? filter;
    const nextDays = next.days ?? days;
    const nextSort = next.sort ?? sort;
    const nextPage = next.page ?? 1;
    const ticket = ++latest.current;
    setFilter(nextFilter);
    setDays(nextDays);
    setSort(nextSort);
    setPage(nextPage);
    setMoreFailed(false);
    if (rangeIsBackwards(nextDays)) {
      // Nothing matches; an answer still on its way for the days as they were must not fill it.
      setOrders([]);
      setCursor(null);
      setTotal(null);
      setSwitching(false);
      return;
    }
    setSwitching(true);
    const result = await callApi<SellerOrderPage>(
      'GET',
      queryOf(nextFilter, nextDays, modeFor(nextPage, nextSort, null)),
    );
    if (ticket !== latest.current) return;
    setSwitching(false);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setMoreFailed(true);
      return;
    }
    setOrders(result.body.sellerOrders);
    setCursor(result.body.nextCursor);
    setTotal(result.body.total ?? null);
  }

  const filtered = days.from !== '' || days.to !== '';
  const everyState = filter === 'all' && !filtered;
  const pageCount = total === null ? 1 : pageCountOf(total);
  const first = total === null ? 0 : (page - 1) * PAGE_SIZE + 1;
  const cut = total !== null && total > MAX_PAGED_ROWS;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      {orders.length === 0 && everyState && !switching ? (
        <EmptyState icon="clipboard" title={t('empty-state.title')} body={t('empty-state.body')} />
      ) : (
        <>
          <Tabs
            label={t('filter.label')}
            activeId={filter}
            onSelect={(id) => {
              if (id !== filter && !switching) void reload({ filter: id as FulfilmentFilter });
            }}
            items={FULFILMENT_FILTERS.map((id) => ({
              id,
              label: t(id === 'all' || id === 'to-ship' ? `filter.${id}` : `status.${id}`),
            }))}
          />
          <div
            role="group"
            aria-label={t('filters.group')}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <TextField
              type="date"
              label={t('filters.from')}
              value={days.from}
              onChange={(event) => void reload({ days: { ...days, from: event.target.value } })}
            />
            <TextField
              type="date"
              label={t('filters.to')}
              value={days.to}
              error={backwards ? t('filters.backwards') : undefined}
              onChange={(event) => void reload({ days: { ...days, to: event.target.value } })}
            />
            {paging === 'pages' ? (
              <Select
                label={t('sort.label')}
                value={sort}
                options={SORTS.map((id) => ({ value: id, label: t(`sort.${id}`) }))}
                onChange={(event) => void reload({ sort: event.target.value as SortId })}
              />
            ) : null}
          </div>
          {filtered ? (
            <div>
              <Button variant="secondary" onClick={() => void reload({ days: NO_DAYS })}>
                {t('filters.clear')}
              </Button>
            </div>
          ) : null}
          {total !== null && orders.length > 0 ? (
            <p className="text-sm text-fg-muted" aria-live="polite">
              {t('range', {
                from: number(first),
                to: number(first + orders.length - 1),
                total: number(total),
              })}
            </p>
          ) : null}
          {orders.length === 0 && !switching ? (
            <EmptyState
              icon="clipboard"
              title={t('filter.empty.title')}
              body={t('filter.empty.body')}
            />
          ) : (
            <OrdersTable orders={orders} />
          )}
        </>
      )}
      {moreFailed ? <Banner tone="critical">{t('error.unavailable')}</Banner> : null}
      {cut ? <Banner tone="info">{t('too-many', { limit: number(MAX_PAGED_ROWS) })}</Banner> : null}
      {paging === 'pages' ? (
        <Pagination
          page={page}
          pageCount={pageCount}
          onPage={(n) => void reload({ page: n })}
          disabled={switching}
          labels={{
            nav: t('paging.nav'),
            previous: t('paging.previous'),
            next: t('paging.next'),
            page: (n) => t('paging.page', { n }),
          }}
        />
      ) : cursor === null ? null : (
        <div>
          <Button variant="secondary" onClick={() => void loadMore()} loading={loadingMore}>
            {t('more')}
          </Button>
        </div>
      )}
    </div>
  );
}
