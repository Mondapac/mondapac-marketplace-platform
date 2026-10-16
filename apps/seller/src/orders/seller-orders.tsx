'use client';

import { Banner, Button, EmptyState, Tabs } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatMinor } from '../price/money.ts';
import { OrdersTable } from './orders-table.tsx';
import {
  FULFILMENT_FILTERS,
  type FulfilmentFilter,
  type OwnFee,
  type SellerOrderPage,
} from './types.ts';

/**
 * The seller's paid orders: a fulfilment filter, the list (each order opens on its own page,
 * where it is shipped and delivered) and "Show more" by cursor. The API has no status
 * parameter, so the filter works on the orders loaded so far.
 */
export function SellerOrders({
  initial,
  fee,
}: {
  readonly initial: SellerOrderPage;
  readonly fee: OwnFee | null;
}) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const [orders, setOrders] = useState(initial.sellerOrders);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [filter, setFilter] = useState<FulfilmentFilter>('all');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  async function loadMore() {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreFailed(false);
    const result = await callApi<SellerOrderPage>(
      'GET',
      `ordering/seller/orders?limit=20&cursor=${encodeURIComponent(cursor)}`,
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

  const shown = filter === 'all' ? orders : orders.filter((order) => order.fulfilment === filter);
  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-(--mp-size-form-max) text-fg-muted">{t('intro')}</p>
      {fee === null ? null : (
        <Banner tone="info">
          {t('fee', { fee: formatMinor(fee.amount, fee.currency, locale) })}
        </Banner>
      )}
      {orders.length === 0 ? (
        <EmptyState icon="clipboard" title={t('empty-state.title')} body={t('empty-state.body')} />
      ) : (
        <>
          <Tabs
            label={t('filter.label')}
            activeId={filter}
            onSelect={(id) => setFilter(id as FulfilmentFilter)}
            items={FULFILMENT_FILTERS.map((id) => ({
              id,
              label: t(id === 'all' ? 'filter.all' : `status.${id}`),
            }))}
          />
          {shown.length === 0 ? (
            <EmptyState
              icon="clipboard"
              title={t('filter.empty.title')}
              body={t(cursor === null ? 'filter.empty.body' : 'filter.empty.body-more')}
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
