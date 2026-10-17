'use client';

import {
  BackLink,
  Badge,
  Banner,
  Button,
  Card,
  CARD_TABLE,
  DataList,
  TextField,
} from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant, shortInstant } from '../catalog/format.ts';
import { formatMinor } from '../price/money.ts';
import { orderProblemOf } from './errors.ts';
import { shortId, TONE } from './status.ts';
import type { SellerOrderView } from './types.ts';

/**
 * One paid order on its own page: summary, its lines with product names, the totals and the
 * fulfilment: the shipment form, the shipment details once shipped and "Mark as delivered".
 */
export function OrderDetail({
  initial,
  csrfToken,
  canShip,
  canDeliver,
}: {
  readonly initial: SellerOrderView;
  readonly csrfToken: string;
  readonly canShip: boolean;
  readonly canDeliver: boolean;
}) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const zone = useTimeZone();
  const [order, setOrder] = useState(initial);
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const busy = useRef(false);
  const money = (amount: { amount: string; currency: string }) =>
    formatMinor(amount.amount, amount.currency, locale);

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
      setOrder(result.body);
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
          <Badge tone={TONE[order.fulfilment]}>{t(`status.${order.fulfilment}`)}</Badge>
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
            {order.fulfilment === 'to-ship' ? (
              canShip ? (
                <form className="flex flex-col gap-4" onSubmit={ship} noValidate>
                  {problem === null ? null : (
                    <Banner tone="critical">{t(`error.${problem}`)}</Banner>
                  )}
                  <TextField
                    name="carrier"
                    label={t('ship.carrier')}
                    value={carrier}
                    maxLength={60}
                    error={
                      fieldError.carrier === undefined
                        ? undefined
                        : t(`validation.${fieldError.carrier}`)
                    }
                    onChange={(event) => setCarrier(event.target.value)}
                  />
                  <TextField
                    name="trackingRef"
                    label={t('ship.tracking')}
                    optionalLabel={t('optional')}
                    value={tracking}
                    maxLength={80}
                    error={
                      fieldError.trackingRef === undefined
                        ? undefined
                        : t(`validation.${fieldError.trackingRef}`)
                    }
                    onChange={(event) => setTracking(event.target.value)}
                  />
                  <p className="text-sm text-balance text-fg-muted">{t('ship.hint')}</p>
                  <div>
                    <Button type="submit" loading={pending}>
                      {t('ship.submit')}
                    </Button>
                  </div>
                </form>
              ) : (
                <p className="text-sm text-fg-muted">{t('not-shipped')}</p>
              )
            ) : (
              <>
                <DataList
                  variant="stacked"
                  missing={t('not-given')}
                  rows={[
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
                {order.fulfilment === 'shipped' && canDeliver ? (
                  <>
                    {problem === null ? null : (
                      <Banner tone="critical">{t(`error.${problem}`)}</Banner>
                    )}
                    <div>
                      <Button
                        variant="secondary"
                        loading={pending}
                        onClick={() => void step('deliver', {})}
                      >
                        {t('deliver')}
                      </Button>
                    </div>
                  </>
                ) : null}
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
