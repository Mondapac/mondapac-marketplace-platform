'use client';

import {
  BackLink,
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  LoadError,
  Spinner,
  toast,
} from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant, shortInstant } from '../catalog/format.ts';
import { formatMinor } from '../price/money.ts';
import { TONE } from '../orders/status.ts';
import { CustomerBadges } from './customer-badges.tsx';
import { CodeText } from './customers-table.tsx';
import { failureOf } from './customers-list.tsx';
import type { SellerCustomerDetail } from './types.ts';

const ORDERS_PAGE_SIZE = 25;

type Outcome =
  | { readonly kind: 'ok'; readonly body: SellerCustomerDetail }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'throttled'; readonly minutes: number }
  | { readonly kind: 'unavailable' };

function Tile({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface p-4">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd className="text-lg font-semibold">{children}</dd>
    </div>
  );
}

/**
 * One of the shop's customers: the code (large, with a copy button), the first name, badges and
 * since when; tiles for orders, spent, last order and followed since; and, with the order view key,
 * only this shop's orders, newest payment first. Nothing here is an email or an account id. A code
 * another shop gave reads as not found.
 */
export function CustomerDetail({ code }: { readonly code: string }) {
  const t = useTranslations('customers');
  const to = useTranslations('orders');
  const tl = useTranslations('load');
  const locale = useLocale();
  const zone = useTimeZone();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  const load = useCallback(
    async (target: number) => {
      const ticket = ++latest.current;
      setLoading(true);
      const result = await callApi<SellerCustomerDetail>(
        'GET',
        `customers/seller/customers/${encodeURIComponent(code)}?page=${target}&pageSize=${ORDERS_PAGE_SIZE}`,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (result.ok) {
        setOutcome({ kind: 'ok', body: result.body });
        return;
      }
      const { failure } = result;
      if (failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      // A code that is not shaped like one is refused (400): to the seller it is the same "not found".
      if (
        (failure.status === 404 && failure.code === 'customers.seller-customer-not-found') ||
        (failure.status === 400 && failure.code === 'validation.failed')
      ) {
        setOutcome({ kind: 'not-found' });
        return;
      }
      const mapped = failureOf(failure);
      setOutcome(
        mapped.kind === 'throttled'
          ? mapped
          : mapped.kind === 'denied'
            ? { kind: 'denied' }
            : { kind: 'unavailable' },
      );
    },
    [code],
  );

  useEffect(() => {
    void load(page);
  }, [load, page]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(t('row-actions.copied'));
    } catch {
      toast.error(t('row-actions.copy-failed'));
    }
  }

  const back = <BackLink href="/customers" label={t('detail.back')} />;
  if (outcome === null) {
    return (
      <div className="flex items-center gap-2 text-fg-muted" role="status">
        <Spinner />
        {t('detail.loading')}
      </div>
    );
  }
  if (outcome.kind === 'not-found') {
    return (
      <EmptyState
        size="page"
        icon="users"
        title={t('detail.not-found.title')}
        body={t('detail.not-found.body')}
        action={back}
      />
    );
  }
  if (outcome.kind === 'denied') {
    return (
      <EmptyState
        size="page"
        icon="lock"
        title={t('denied.title')}
        body={t('denied.body')}
        action={back}
      />
    );
  }
  if (outcome.kind === 'throttled' || outcome.kind === 'unavailable') {
    return (
      <div className="flex flex-col items-start gap-2">
        {back}
        <LoadError
          className="w-full"
          message={
            outcome.kind === 'throttled'
              ? t('error.throttled', { minutes: outcome.minutes })
              : t('detail.error')
          }
          retryLabel={tl('retry')}
          onRetry={() => void load(page)}
        />
      </div>
    );
  }
  const { customer, orders } = outcome.body;
  const day = (iso: string | null) => (iso === null ? t('none') : formatInstant(iso, locale, zone));
  const lastPage = orders === null ? 1 : Math.max(1, Math.ceil(orders.total / orders.pageSize));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-3">
        {back}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">
            <CodeText code={customer.code} />
          </h1>
          <Button variant="secondary" onClick={() => void copy()}>
            {t('detail.copy')}
          </Button>
        </div>
        <p className="text-fg-muted">{customer.firstName ?? t('detail.no-name')}</p>
        <CustomerBadges customer={customer} />
        <p className="text-sm text-fg-muted">{t('detail.since', { date: day(customer.since) })}</p>
      </div>
      <Banner tone="info">{t('detail.privacy')}</Banner>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label={t('col.orders')}>{customer.orderCount}</Tile>
        <Tile label={t('col.spent')}>
          {customer.spentMinor === null || customer.currency === null ? (
            t('none')
          ) : (
            <span dir="ltr">{formatMinor(customer.spentMinor, customer.currency, locale)}</span>
          )}
        </Tile>
        <Tile label={t('col.lastOrder')}>{day(customer.lastOrderAt)}</Tile>
        <Tile label={t('col.followed')}>{day(customer.followedAt)}</Tile>
      </dl>
      {orders === null ? null : (
        <section aria-labelledby="customer-orders" className="flex flex-col gap-3">
          <div>
            <h2 id="customer-orders" className="text-lg font-semibold">
              {t('detail.orders.title')}
            </h2>
            <p className="text-sm text-fg-muted">{t('detail.orders.subtitle')}</p>
          </div>
          {orders.items.length === 0 ? (
            <p className="text-fg-muted">{t('detail.orders.empty')}</p>
          ) : (
            <Card flush>
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm" aria-busy={loading}>
                  <caption className="sr-only">{t('detail.orders.title')}</caption>
                  <thead className="max-sm:sr-only">
                    <tr className="border-b border-line text-start text-fg-muted">
                      <th scope="col" className="px-4 py-2 text-start font-medium">
                        {to('col.order')}
                      </th>
                      <th scope="col" className="px-4 py-2 text-start font-medium">
                        {to('col.paid')}
                      </th>
                      <th scope="col" className="px-4 py-2 text-end font-medium">
                        {to('col.total')}
                      </th>
                      <th scope="col" className="px-4 py-2 text-start font-medium">
                        {to('col.status')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className={loading ? 'opacity-60' : ''}>
                    {orders.items.map((order) => (
                      <tr
                        key={order.sellerOrderId}
                        className="border-b border-line-row last:border-b-0 max-sm:flex max-sm:flex-wrap max-sm:justify-between max-sm:gap-x-4"
                      >
                        <td className="px-4 py-3">
                          <a
                            className="font-medium text-link underline"
                            href={`/orders/${order.sellerOrderId}`}
                          >
                            {to('ref', { id: order.sellerOrderId.slice(-8).toUpperCase() })}
                          </a>
                        </td>
                        <td className="px-4 py-3">
                          <time dateTime={order.paidAt}>
                            {shortInstant(order.paidAt, locale, zone)}
                          </time>
                        </td>
                        <td className="px-4 py-3 text-end">
                          <span dir="ltr">
                            {formatMinor(order.totalMinor, order.currency, locale)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone={TONE[order.fulfilment]}>
                            {to(`status.${order.fulfilment}`)}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          {lastPage > 1 ? (
            <nav aria-label={t('detail.orders.paging')} className="flex items-center gap-3">
              <Button
                variant="secondary"
                disabled={loading || page <= 1}
                onClick={() => setPage(page - 1)}
              >
                {t('paging.previous')}
              </Button>
              <span className="text-sm text-fg-muted">
                {t('detail.orders.page', { page, last: lastPage })}
              </span>
              <Button
                variant="secondary"
                disabled={loading || page >= lastPage}
                onClick={() => setPage(page + 1)}
              >
                {t('paging.next')}
              </Button>
            </nav>
          ) : null}
        </section>
      )}
    </div>
  );
}
