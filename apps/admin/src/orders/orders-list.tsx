'use client';

import { Banner, Button, EmptyState, LoadError, SkeletonRows, Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { OrdersTable } from './orders-table.tsx';
import { FILTERS, type AdminOrder, type AdminOrderPage, type StatusFilter } from './types.ts';

/**
 * The Market's orders (read-only): a tab for each status, newest first, paged by cursor with
 * "Show more".
 */
export function OrdersList() {
  const t = useTranslations('orders');
  const tl = useTranslations('load');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [rows, setRows] = useState<readonly AdminOrder[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<'first' | 'more' | null>(null);
  const latest = useRef(0);

  const load = useCallback(
    async (after: string | null) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailed(null);
      // A new first page replaces the list at once: the old tab's rows never show under a new tab.
      if (after === null) {
        setRows([]);
        setNext(null);
      }
      const query = new URLSearchParams();
      if (filter !== 'all') query.set('status', filter);
      if (after !== null) query.set('cursor', after);
      const text = query.toString();
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
        setFailed(after === null ? 'first' : 'more');
        if (after === null) {
          setRows([]);
          setNext(null);
        }
        return;
      }
      setRows((current) => {
        if (after === null) return result.body.orders;
        const known = new Set(current.map((row) => row.orderId));
        return [...current, ...result.body.orders.filter((row) => !known.has(row.orderId))];
      });
      setNext(result.body.nextCursor);
    },
    [filter],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      <Tabs
        label={t('tabs')}
        activeId={filter}
        onSelect={(id) => setFilter(id as StatusFilter)}
        items={FILTERS.map((id) => ({ id, label: t(id === 'all' ? 'tab.all' : `status.${id}`) }))}
      />
      {failed === 'first' ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
          message={t('error.unavailable')}
          retryLabel={tl('retry')}
          onRetry={() => void load(null)}
        />
      ) : null}
      {rows.length > 0 ? <OrdersTable rows={rows} /> : null}
      {!loading && failed === null && rows.length === 0 ? (
        <EmptyState icon="receipt" title={t(filter === 'all' ? 'empty.all' : 'empty.status')} />
      ) : null}
      {loading ? <SkeletonRows label={t('loading')} rows={rows.length > 0 ? 1 : 3} /> : null}
      {failed === 'more' ? <Banner tone="critical">{t('error.unavailable')}</Banner> : null}
      {next !== null && !loading ? (
        <div>
          <Button variant="secondary" onClick={() => void load(next)}>
            {t('more')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
