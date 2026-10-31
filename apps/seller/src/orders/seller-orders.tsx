'use client';

import { Banner, Button, EmptyState, Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import { OrdersTable } from './orders-table.tsx';
import { FULFILMENT_FILTERS, type FulfilmentFilter, type SellerOrderPage } from './types.ts';

/**
 * The seller's paid orders: a fulfilment filter, the list (each order opens on its own page,
 * where it is shipped and delivered) and "Show more" by cursor. The filter is the API's `status`
 * parameter, so a tab lists every order in that state, not only the ones loaded so far.
 */
export function SellerOrders({ initial }: { readonly initial: SellerOrderPage }) {
  const t = useTranslations('orders');
  const [orders, setOrders] = useState(initial.sellerOrders);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [filter, setFilter] = useState<FulfilmentFilter>('all');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const [switching, setSwitching] = useState(false);

  const pathFor = (status: FulfilmentFilter, after: string | null) =>
    `ordering/seller/orders?limit=20${status === 'all' ? '' : `&status=${status}`}${
      after === null ? '' : `&cursor=${encodeURIComponent(after)}`
    }`;

  async function loadMore() {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    const result = await callApi<SellerOrderPage>('GET', pathFor(filter, cursor));
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

  /** A tab asks the API for the first page of that state; the old rows stay until it answers. */
  async function selectFilter(next: FulfilmentFilter) {
    if (next === filter || switching) return;
    setSwitching(true);
    setMoreFailed(false);
    const result = await callApi<SellerOrderPage>('GET', pathFor(next, null));
    setSwitching(false);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setMoreFailed(true);
      return;
    }
    setFilter(next);
    setOrders(result.body.sellerOrders);
    setCursor(result.body.nextCursor);
  }

  const shown = orders;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      {orders.length === 0 && filter === 'all' ? (
        <EmptyState icon="clipboard" title={t('empty-state.title')} body={t('empty-state.body')} />
      ) : (
        <>
          <Tabs
            label={t('filter.label')}
            activeId={filter}
            onSelect={(id) => void selectFilter(id as FulfilmentFilter)}
            items={FULFILMENT_FILTERS.map((id) => ({
              id,
              label: t(id === 'all' || id === 'to-ship' ? `filter.${id}` : `status.${id}`),
            }))}
          />
          {shown.length === 0 ? (
            <EmptyState
              icon="clipboard"
              title={t('filter.empty.title')}
              body={t('filter.empty.body')}
            />
          ) : (
            <OrdersTable orders={shown} />
          )}
        </>
      )}
      {moreFailed ? <Banner tone="critical">{t('error.unavailable')}</Banner> : null}
      {cursor === null ? null : (
        <div>
          <Button variant="secondary" onClick={() => void loadMore()} loading={loadingMore}>
            {t('more')}
          </Button>
        </div>
      )}
    </div>
  );
}
