'use client';

import { Badge, Banner, Button, Card, EmptyState, TextField, type BadgeTone } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { dateFormat } from '../shared/intl.ts';
import { formatMinor } from '../price/money.ts';
import { orderProblemOf } from './errors.ts';
import type { Fulfilment, OwnFee, SellerOrderPage, SellerOrderView } from './types.ts';

const TONE: Record<Fulfilment, BadgeTone> = {
  'to-ship': 'attention',
  shipped: 'info',
  delivered: 'success',
};

/** An instant in UTC, so the server and the browser print the same text. */
const when = (instant: string, locale: string): string =>
  `${dateFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(instant))} UTC`;
const shortId = (id: string): string => id.slice(-8).toUpperCase();

export function SellerOrders({
  initial,
  fee,
  csrfToken,
  canShip,
  canDeliver,
}: {
  readonly initial: SellerOrderPage;
  readonly fee: OwnFee | null;
  readonly csrfToken: string;
  readonly canShip: boolean;
  readonly canDeliver: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [orders, setOrders] = useState(initial.sellerOrders);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  function replace(next: SellerOrderView) {
    setOrders((current) =>
      current.map((order) => (order.sellerOrderId === next.sellerOrderId ? next : order)),
    );
  }

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

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-(--mp-size-form-max) text-fg-muted">{t('orders.intro')}</p>
      {fee === null ? null : (
        <Banner tone="info">
          {t('orders.fee', { fee: formatMinor(fee.amount, fee.currency, locale) })}
        </Banner>
      )}
      {orders.length === 0 ? (
        <EmptyState
          icon="clipboard"
          title={t('orders.empty-state.title')}
          body={t('orders.empty-state.body')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((order) => (
            <OrderCard
              key={order.sellerOrderId}
              order={order}
              csrfToken={csrfToken}
              canShip={canShip}
              canDeliver={canDeliver}
              onChange={replace}
            />
          ))}
        </ul>
      )}
      {moreFailed ? <Banner tone="critical">{t('orders.error.unavailable')}</Banner> : null}
      {cursor === null ? null : (
        <div>
          <Button variant="secondary" onClick={() => void loadMore()} loading={loadingMore}>
            {t('orders.more')}
          </Button>
        </div>
      )}
    </div>
  );
}

function OrderCard({
  order,
  csrfToken,
  canShip,
  canDeliver,
  onChange,
}: {
  readonly order: SellerOrderView;
  readonly csrfToken: string;
  readonly canShip: boolean;
  readonly canDeliver: boolean;
  readonly onChange: (next: SellerOrderView) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const busy = useRef(false);

  /** One step at a time; the answer is the new state of this order. */
  async function step(action: 'ship' | 'deliver', body: unknown) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    setFieldError({});
    const result = await callApi<SellerOrderView>(
      'POST',
      `ordering/seller/orders/${order.sellerOrderId}/${action}`,
      body,
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onChange(result.body);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const fields: Record<string, string> = {};
    for (const entry of result.failure.details?.fields ?? []) fields[entry.path] = 'invalid';
    setFieldError(fields);
    setProblem(orderProblemOf(result.failure));
  }

  function ship(event: FormEvent) {
    event.preventDefault();
    const name = carrier.trim();
    if (name === '') {
      setFieldError({ carrier: 'required' });
      return;
    }
    const ref = tracking.trim();
    void step('ship', ref === '' ? { carrier: name } : { carrier: name, trackingRef: ref });
  }

  const status = t(`orders.status.${order.fulfilment}`);
  return (
    <li>
      <Card title={t('orders.card-title', { id: shortId(order.sellerOrderId) })}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Badge tone={TONE[order.fulfilment]}>{status}</Badge>
            <span>{t('orders.paid', { when: when(order.paidAt, locale) })}</span>
          </div>
          <ul className="flex flex-col gap-1 text-sm">
            {order.lines.map((line, index) => (
              <li key={line.lineId} className="flex flex-wrap justify-between gap-x-3">
                <span>
                  {t('orders.line', { n: index + 1, quantity: line.quantity })}
                  <span className="text-fg-muted">
                    {' '}
                    ·{' '}
                    {t('orders.each', {
                      price: formatMinor(line.unitPrice.amount, line.unitPrice.currency, locale),
                    })}
                  </span>
                </span>
                <span>{formatMinor(line.lineAmount.amount, line.lineAmount.currency, locale)}</span>
              </li>
            ))}
          </ul>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-line pt-2 text-sm">
            <dt className="text-fg-muted">{t('orders.subtotal')}</dt>
            <dd className="text-end">
              {formatMinor(order.subtotal.amount, order.subtotal.currency, locale)}
            </dd>
            <dt className="text-fg-muted">{t('orders.delivery')}</dt>
            <dd className="text-end">
              {order.shipping.amount === '0'
                ? t('orders.delivery-free')
                : formatMinor(order.shipping.amount, order.shipping.currency, locale)}
            </dd>
            <dt className="font-semibold">{t('orders.total')}</dt>
            <dd className="text-end font-semibold">
              {formatMinor(order.total.amount, order.total.currency, locale)}
            </dd>
          </dl>
          {order.fulfilment === 'to-ship' && canShip ? (
            <form
              className="flex flex-col gap-3 border-t border-line pt-3 *:max-w-(--mp-size-form-max)"
              onSubmit={ship}
              noValidate
            >
              <h3 className="text-sm font-semibold">{t('orders.ship.title')}</h3>
              {problem === null ? null : (
                <Banner tone="critical">{t(`orders.error.${problem}`)}</Banner>
              )}
              <TextField
                name="carrier"
                label={t('orders.ship.carrier')}
                value={carrier}
                maxLength={60}
                error={
                  fieldError.carrier === undefined
                    ? undefined
                    : t(`orders.validation.${fieldError.carrier}`)
                }
                onChange={(event) => setCarrier(event.target.value)}
              />
              <TextField
                name="trackingRef"
                label={t('orders.ship.tracking')}
                optionalLabel={t('orders.optional')}
                value={tracking}
                maxLength={80}
                error={
                  fieldError.trackingRef === undefined
                    ? undefined
                    : t(`orders.validation.${fieldError.trackingRef}`)
                }
                onChange={(event) => setTracking(event.target.value)}
              />
              <p className="text-sm text-balance text-fg-muted">{t('orders.ship.hint')}</p>
              <div>
                <Button type="submit" loading={pending}>
                  {t('orders.ship.submit')}
                </Button>
              </div>
            </form>
          ) : null}
          {order.fulfilment !== 'to-ship' ? (
            <div className="flex flex-col gap-2 border-t border-line pt-3 text-sm">
              <p>
                <span className="text-fg-muted">{t('orders.ship.carrier')}: </span>
                {order.carrier}
                {order.trackingRef === null ? null : (
                  <>
                    <span className="text-fg-muted"> · {t('orders.ship.tracking')}: </span>
                    {order.trackingRef}
                  </>
                )}
              </p>
              {order.shippedAt === null ? null : (
                <p className="text-fg-muted">
                  {t('orders.shipped-at', { when: when(order.shippedAt, locale) })}
                </p>
              )}
              {order.deliveredAt === null ? null : (
                <p className="text-fg-muted">
                  {t('orders.delivered-at', { when: when(order.deliveredAt, locale) })}
                </p>
              )}
              {order.fulfilment === 'shipped' && canDeliver ? (
                <>
                  {problem === null ? null : (
                    <Banner tone="critical">{t(`orders.error.${problem}`)}</Banner>
                  )}
                  <div>
                    <Button
                      variant="secondary"
                      loading={pending}
                      onClick={() => void step('deliver', {})}
                    >
                      {t('orders.deliver')}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>
    </li>
  );
}
