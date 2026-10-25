'use client';

import { BackLink, Badge, Banner, Button, Card, CARD_TABLE, DataList } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant, shortInstant } from '../catalog/format.ts';
import { formatMinor } from '../price/money.ts';
import { orderProblemOf } from './errors.ts';
import { shortId, statusOf, TONE } from './status.ts';
import type { SellerOrderView } from './types.ts';

/**
 * One paid order on its own page: summary, its lines with product names, the totals and the
 * fulfilment. The shop's one action is "Mark ready": it tells MondaPac the order is packed. The
 * shop never picks a courier, a method or a provider; the customer's method is shown for
 * information, and the shipment details appear once the platform's courier has picked it up.
 */
export function OrderDetail({
  initial,
  csrfToken,
  canMarkReady,
  canDeliver,
}: {
  readonly initial: SellerOrderView;
  readonly csrfToken: string;
  readonly canMarkReady: boolean;
  readonly canDeliver: boolean;
}) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const zone = useTimeZone();
  const [order, setOrder] = useState(initial);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);
  const money = (amount: { amount: string; currency: string }) =>
    formatMinor(amount.amount, amount.currency, locale);

  /** One step at a time; the answer is the new state of this order. */
  async function step(action: 'ready' | 'deliver') {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<SellerOrderView>(
      'POST',
      `ordering/seller/orders/${order.sellerOrderId}/${action}`,
      {},
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setOrder(result.body);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(orderProblemOf(result.failure));
  }

  const method = t(`method.${order.deliveryMethod}`);
  const methodText =
    order.deliveryMethod === 'scheduled' &&
    order.deliveryWindowStart !== null &&
    order.deliveryWindowEnd !== null
      ? `${method} · ${t('method.window', {
          start: shortInstant(order.deliveryWindowStart, locale, zone),
          end: shortInstant(order.deliveryWindowEnd, locale, zone),
        })}`
      : method;
  const reference = shortId(order.sellerOrderId);
  const count = order.lines.reduce((sum, line) => sum + line.quantity, 0);
  const lineHead = (col: 'item' | 'quantity' | 'unit' | 'amount') => t(`line.col.${col}`);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-start gap-2">
        <BackLink href="/orders" label={t('back')} />
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-2xl font-semibold">
            {t('detail-title', { id: reference })}
          </h1>
          <Badge tone={TONE[statusOf(order)]}>{t(`status.${statusOf(order)}`)}</Badge>
        </div>
        <p className="text-sm text-fg-muted">
          {t('paid-line', { when: formatInstant(order.paidAt, locale, zone) })}
          {' · '}
          {t('items-count', { count })}
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          <Card title={t('lines')} flush>
            <div className="relative overflow-x-auto">
              <table className={`${CARD_TABLE.table} lg:table-fixed`}>
                <caption className="sr-only">{t('lines')}</caption>
                <colgroup className="max-lg:hidden">
                  <col />
                  <col className="w-20" />
                  <col className="w-28" />
                  <col className="w-28" />
                </colgroup>
                <thead className={CARD_TABLE.head}>
                  <tr>
                    <th scope="col" className="px-5 py-3 font-medium">
                      {lineHead('item')}
                    </th>
                    <th scope="col" className="px-4 py-3 text-end font-medium">
                      {lineHead('quantity')}
                    </th>
                    <th scope="col" className="px-4 py-3 text-end font-medium">
                      {lineHead('unit')}
                    </th>
                    <th scope="col" className="px-5 py-3 text-end font-medium">
                      {lineHead('amount')}
                    </th>
                  </tr>
                </thead>
                <tbody className={CARD_TABLE.body}>
                  {order.lines.map((line) => {
                    const name = line.productName?.trim() ?? '';
                    const variant = line.variantLabel?.trim() ?? '';
                    return (
                      <tr key={line.lineId} className={CARD_TABLE.row}>
                        <td className={`${CARD_TABLE.cell} break-words lg:px-5`}>
                          <div className="font-medium text-fg">
                            {name === '' ? t('line.fallback', { id: shortId(line.offerId) }) : name}
                            {variant !== '' ? ` · ${variant}` : ''}
                          </div>
                        </td>
                        <td className={`${CARD_TABLE.cell} tabular-nums max-lg:hidden lg:text-end`}>
                          {line.quantity}
                        </td>
                        <td className={`${CARD_TABLE.cell} tabular-nums max-lg:hidden lg:text-end`}>
                          {money(line.unitPrice)}
                        </td>
                        <td
                          className={`${CARD_TABLE.corner} font-medium tabular-nums lg:px-5 lg:text-end`}
                        >
                          {money(line.lineAmount)}
                        </td>
                        {/* Phones: quantity and unit price on one line under the name. */}
                        <td className="text-fg-muted max-lg:col-span-2 lg:hidden">
                          {t('line.qty-price', {
                            quantity: line.quantity,
                            price: money(line.unitPrice),
                          })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <Card title={t('totals')}>
            <DataList
              variant="totals"
              missing={t('not-given')}
              rows={[
                { label: t('subtotal'), value: money(order.subtotal) },
                {
                  label: t('delivery'),
                  value: order.shipping.amount === '0' ? t('delivery-free') : money(order.shipping),
                },
                { label: t('total'), value: money(order.total), emphasis: true },
              ]}
            />
          </Card>
          <Card title={t('fulfilment')}>
            <div className="flex flex-col gap-4">
              <DataList
                variant="stacked"
                missing={t('not-given')}
                rows={[
                  { label: t('method.label'), value: methodText },
                  ...(order.fulfilment === 'to-ship'
                    ? []
                    : [
                        { label: t('ship.carrier'), value: order.carrier },
                        {
                          label: t('ship.tracking'),
                          value:
                            order.trackingRef === null ? null : (
                              <span className="break-all">{order.trackingRef}</span>
                            ),
                        },
                        {
                          label: t('shipped-on'),
                          value:
                            order.shippedAt === null
                              ? null
                              : shortInstant(order.shippedAt, locale, zone),
                        },
                      ]),
                  ...(order.deliveredAt === null
                    ? []
                    : [
                        {
                          label: t('delivered-on'),
                          value: shortInstant(order.deliveredAt, locale, zone),
                        },
                      ]),
                ]}
              />
              {order.fulfilment === 'to-ship' && order.readyAt === null ? (
                canMarkReady ? (
                  <>
                    {problem === null ? null : (
                      <Banner tone="critical">{t(`error.${problem}`)}</Banner>
                    )}
                    <p className="text-sm text-balance text-fg-muted">{t('ready.hint')}</p>
                    <div>
                      <Button loading={pending} onClick={() => void step('ready')}>
                        {t('ready.submit')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-fg-muted">{t('not-ready')}</p>
                )
              ) : null}
              {order.fulfilment === 'to-ship' && order.readyAt !== null ? (
                <div className="flex flex-col gap-2 text-sm text-fg-muted">
                  <p className="text-fg">
                    {t('ready.done', { when: shortInstant(order.readyAt, locale, zone) })}
                  </p>
                  <p>
                    {order.deliveryMethod === 'pickup'
                      ? t('ready.pickup')
                      : t(order.deliveryAttention === null ? 'ready.arranged' : 'ready.attention')}
                  </p>
                </div>
              ) : null}
              {order.fulfilment === 'shipped' && canDeliver ? (
                <>
                  {problem === null ? null : (
                    <Banner tone="critical">{t(`error.${problem}`)}</Banner>
                  )}
                  <div>
                    <Button
                      variant="secondary"
                      loading={pending}
                      onClick={() => void step('deliver')}
                    >
                      {t('deliver')}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
